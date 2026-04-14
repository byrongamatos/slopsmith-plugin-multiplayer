"""Multiplayer plugin — synced rooms, shared queue, optional mixdown."""

import asyncio
import math
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse


_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 30 chars, no 0/O/1/I/L

_rooms = {}           # code -> room dict
_cleanup_tasks = {}   # code -> asyncio.Task


def _gen_code():
    for _ in range(100):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if code not in _rooms:
            return code
    raise RuntimeError("Failed to generate unique room code")


def _gen_player_id():
    return secrets.token_hex(8)


def _serialize_room(room):
    """Return room state safe for JSON (no WebSocket refs)."""
    players = {}
    for pid, p in room["players"].items():
        players[pid] = {
            "name": p["name"],
            "arrangement": p["arrangement"],
            "connected": p["connected"],
        }
    return {
        "code": room["code"],
        "host": room["host"],
        "players": players,
        "queue": room["queue"],
        "now_playing": room["now_playing"],
        "state": room["state"],
        "time": room["time"],
        "speed": room["speed"],
        "recording": room["recording"],
        "recordings_received": list(room["recordings"].keys()),
    }


async def _broadcast(room, msg, exclude=None):
    """Send JSON message to all connected players in a room."""
    for pid, p in room["players"].items():
        if pid == exclude:
            continue
        ws = p.get("ws")
        if ws and p["connected"]:
            try:
                await ws.send_json(msg)
            except Exception:
                pass


def _connected_count(room):
    return sum(1 for p in room["players"].values() if p["connected"])


def _promote_host(room):
    """Promote the first connected player to host."""
    for pid, p in room["players"].items():
        if p["connected"]:
            room["host"] = pid
            return pid
    return None


def setup(app, context):
    config_dir = context["config_dir"]
    STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"
    MP_DIR = config_dir / "multiplayer"
    _get_dlc_dir = context.get("get_dlc_dir")

    # ── Room CRUD ──────────────────────────────────────────────────────

    @app.post("/api/plugins/multiplayer/rooms")
    async def create_room(data: dict):
        name = (data.get("name") or "").strip() or "Player"
        code = _gen_code()
        player_id = _gen_player_id()
        room = {
            "code": code,
            "host": player_id,
            "created_at": time.monotonic(),
            "players": {
                player_id: {
                    "name": name,
                    "arrangement": "Lead",
                    "connected": False,
                    "ws": None,
                    "last_seen": time.monotonic(),
                }
            },
            "queue": [],
            "now_playing": -1,
            "state": "stopped",
            "time": 0.0,
            "speed": 1.0,
            "recording": False,
            "recordings": {},
            "mixdown_path": None,
            "skip_votes": set(),
        }
        _rooms[code] = room
        return {"code": code, "player_id": player_id, "is_host": True}

    @app.post("/api/plugins/multiplayer/rooms/{code}/join")
    async def join_room(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        name = (data.get("name") or "").strip() or "Player"
        player_id = _gen_player_id()
        room["players"][player_id] = {
            "name": name,
            "arrangement": "Lead",
            "connected": False,
            "ws": None,
            "last_seen": time.monotonic(),
        }
        await _broadcast(room, {
            "type": "player_joined",
            "player_id": player_id,
            "name": name,
            "arrangement": "Lead",
        })
        return {
            "code": room["code"],
            "player_id": player_id,
            "is_host": False,
            "room": _serialize_room(room),
        }

    @app.get("/api/plugins/multiplayer/rooms/{code}")
    async def get_room(code: str):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        return _serialize_room(room)

    @app.post("/api/plugins/multiplayer/rooms/{code}/leave")
    async def leave_room(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        player_id = data.get("player_id", "")
        if player_id not in room["players"]:
            return JSONResponse({"error": "Player not in room"}, 404)

        # Close WebSocket if connected
        ws = room["players"][player_id].get("ws")
        if ws:
            try:
                await ws.close()
            except Exception:
                pass

        del room["players"][player_id]
        await _broadcast(room, {"type": "player_left", "player_id": player_id})

        # Promote host if needed
        if room["host"] == player_id and room["players"]:
            new_host = _promote_host(room)
            if new_host:
                await _broadcast(room, {"type": "host_changed", "new_host_id": new_host})

        # Check if room is empty
        if not room["players"]:
            _start_cleanup(code)

        return {"ok": True}

    # ── Queue ──────────────────────────────────────────────────────────

    @app.post("/api/plugins/multiplayer/rooms/{code}/queue")
    async def add_to_queue(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        item = {
            "filename": data.get("filename", ""),
            "title": data.get("title", ""),
            "artist": data.get("artist", ""),
            "added_by": data.get("player_id", ""),
            "arrangements": data.get("arrangements", []),
        }
        room["queue"].append(item)
        await _broadcast(room, {
            "type": "queue_updated",
            "queue": room["queue"],
            "now_playing": room["now_playing"],
        })
        return {"ok": True}

    @app.delete("/api/plugins/multiplayer/rooms/{code}/queue/{index}")
    async def remove_from_queue(code: str, index: int, player_id: str = ""):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        if index < 0 or index >= len(room["queue"]):
            return JSONResponse({"error": "Invalid index"}, 400)
        room["queue"].pop(index)
        # Adjust now_playing
        if room["now_playing"] >= len(room["queue"]):
            room["now_playing"] = len(room["queue"]) - 1
        elif index < room["now_playing"]:
            room["now_playing"] -= 1
        await _broadcast(room, {
            "type": "queue_updated",
            "queue": room["queue"],
            "now_playing": room["now_playing"],
        })
        return {"ok": True}

    @app.post("/api/plugins/multiplayer/rooms/{code}/queue/reorder")
    async def reorder_queue(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        indices = data.get("indices", [])
        if sorted(indices) != list(range(len(room["queue"]))):
            return JSONResponse({"error": "Invalid indices"}, 400)
        room["queue"] = [room["queue"][i] for i in indices]
        await _broadcast(room, {
            "type": "queue_updated",
            "queue": room["queue"],
            "now_playing": room["now_playing"],
        })
        return {"ok": True}

    @app.post("/api/plugins/multiplayer/rooms/{code}/vote-skip")
    async def vote_skip(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        player_id = data.get("player_id", "")
        room["skip_votes"].add(player_id)
        connected = _connected_count(room)
        needed = max(1, math.ceil(connected / 2))
        votes = len(room["skip_votes"])

        if votes >= needed:
            # Skip to next song
            room["skip_votes"] = set()
            await _advance_song(room)
        else:
            await _broadcast(room, {
                "type": "vote_skip",
                "votes": votes,
                "needed": needed,
                "voter": player_id,
            })
        return {"ok": True, "votes": votes, "needed": needed}

    # ── Recording Upload + Mixdown ─────────────────────────────────────

    @app.post("/api/plugins/multiplayer/rooms/{code}/upload")
    async def upload_recording(
        code: str,
        file: UploadFile = File(...),
        player_id: str = Form(""),
        start_server_time: str = Form("0"),
    ):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        if player_id not in room["players"]:
            return JSONResponse({"error": "Player not in room"}, 404)

        try:
            rec_start_ms = float(start_server_time)
        except (ValueError, TypeError):
            rec_start_ms = 0.0

        # Save raw upload
        room_dir = MP_DIR / code
        room_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(file.filename).suffix if file.filename else ".webm"
        if ext not in (".wav", ".webm", ".ogg", ".mp3"):
            ext = ".webm"
        raw_path = room_dir / f"{player_id}_raw{ext}"
        content = await file.read()
        raw_path.write_bytes(content)

        # Convert to WAV
        wav_path = room_dir / f"{player_id}.wav"
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(raw_path), "-ar", "48000", str(wav_path)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode == 0 and wav_path.exists():
                raw_path.unlink(missing_ok=True)
                print(f"[Multiplayer] Converted recording for {player_id}: {wav_path}")
            else:
                print(f"[Multiplayer] WAV conversion failed: {result.stderr[-300:]}")
                wav_path = raw_path
        except Exception as e:
            print(f"[Multiplayer] WAV conversion error: {e}")
            wav_path = raw_path

        room["recordings"][player_id] = {
            "path": str(wav_path),
            "start_ms": rec_start_ms,
        }

        await _broadcast(room, {
            "type": "recording_uploaded",
            "player_id": player_id,
            "total_uploads": len(room["recordings"]),
            "total_players": _connected_count(room),
        })
        return {"ok": True}

    @app.post("/api/plugins/multiplayer/rooms/{code}/mixdown")
    async def trigger_mixdown(code: str, data: dict):
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)
        if data.get("player_id") != room["host"]:
            return JSONResponse({"error": "Only the host can trigger mixdown"}, 403)
        if not room["recordings"]:
            return JSONResponse({"error": "No recordings to mix"}, 400)

        include_stems = data.get("include_stems")       # list of stem IDs, or None for all
        include_recordings = data.get("include_recordings")  # list of player IDs, or None for all
        track_offsets = data.get("track_offsets", {})  # {track_id: offset_ms} from mixer
        track_volumes = data.get("track_volumes", {})  # {track_id: 0.0-1.0} from mixer
        track_mutes = data.get("track_mutes", [])      # [track_id, ...] muted tracks

        # Find the song audio files from the DLC directory
        song_audio_files = []  # list of (stem_id, path) tuples
        if 0 <= room["now_playing"] < len(room["queue"]):
            queue_item = room["queue"][room["now_playing"]]
            filename = queue_item.get("filename", "")
            if filename and callable(_get_dlc_dir):
                dlc = _get_dlc_dir()
                if dlc:
                    song_path = dlc / filename
                    if song_path.exists():
                        try:
                            import sloppak as sloppak_mod
                            if sloppak_mod.is_sloppak(song_path):
                                cache_dir = context.get("get_sloppak_cache_dir", lambda: None)()
                                source_dir = sloppak_mod.resolve_source_dir(filename, dlc, cache_dir)
                                manifest = sloppak_mod.load_manifest(song_path)
                                # Collect all stems as separate inputs
                                stems = manifest.get("stems", []) or []
                                for s in stems:
                                    if isinstance(s, dict) and s.get("file"):
                                        sid = str(s.get("id", ""))
                                        if include_stems is not None and sid not in include_stems:
                                            continue
                                        stem_path = source_dir / s["file"]
                                        if stem_path.exists():
                                            song_audio_files.append((sid, str(stem_path)))
                                # Fall back to main audio if no stems
                                if not song_audio_files:
                                    audio_file = manifest.get("audio", "")
                                    if audio_file:
                                        audio_path = source_dir / audio_file
                                        if audio_path.exists():
                                            song_audio_files.append(("mix", str(audio_path)))
                        except Exception:
                            pass
                        # Non-sloppak: check audio cache
                        if not song_audio_files:
                            cached = STATIC_DIR / "audio_cache"
                            if cached.is_dir():
                                stem_name = song_path.stem
                                for ext in (".ogg", ".mp3", ".wav"):
                                    cached_file = cached / f"{stem_name}{ext}"
                                    if cached_file.exists():
                                        song_audio_files.append(("mix", str(cached_file)))
                                        break

        room_dir = MP_DIR / code
        room_dir.mkdir(parents=True, exist_ok=True)

        # Build FFmpeg command
        inputs = []
        filter_parts = []
        idx = 0

        # Add selected song audio tracks as inputs (with mixer offsets/volumes)
        for sid, audio_path in song_audio_files:
            if sid in track_mutes:
                continue
            offset_ms = max(0, round(track_offsets.get(sid, 0)))
            vol = track_volumes.get(sid, 1.0)
            inputs.extend(["-i", audio_path])
            filt = f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo"
            if offset_ms > 0:
                filt += f",adelay={offset_ms}|{offset_ms}"
            if abs(vol - 1.0) > 0.01:
                filt += f",volume={vol:.3f}"
            filt += f"[a{idx}]"
            filter_parts.append(filt)
            idx += 1

        # Collect player recordings
        rec_entries = []
        for pid, rec_info in room["recordings"].items():
            if include_recordings is not None and pid not in include_recordings:
                continue
            rec_path = rec_info["path"] if isinstance(rec_info, dict) else rec_info
            start_ms = rec_info.get("start_ms", 0) if isinstance(rec_info, dict) else 0
            if Path(rec_path).exists():
                rec_entries.append((pid, rec_path, start_ms))

        # Add player recordings with mixer offsets (falls back to auto start_ms)
        for pid, rec_path, _start_ms in rec_entries:
            track_id = f"rec_{pid}"
            if track_id in track_mutes:
                continue
            offset_ms = max(0, round(track_offsets.get(track_id, _start_ms)))
            vol = track_volumes.get(track_id, 1.0)
            inputs.extend(["-i", rec_path])
            filt = f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo"
            if offset_ms > 0:
                filt += f",adelay={offset_ms}|{offset_ms}"
            if abs(vol - 1.0) > 0.01:
                filt += f",volume={vol:.3f}"
            filt += f"[a{idx}]"
            filter_parts.append(filt)
            idx += 1

        if idx == 0:
            return JSONResponse({"error": "No audio tracks available"}, 400)

        # Build amix filter — loudnorm each input to -16 LUFS so stems
        # and recordings sit at comparable levels before mixing.
        norm_parts = []
        for i in range(idx):
            norm_parts.append(
                f"[a{i}]loudnorm=I=-16:TP=-1:LRA=11[n{i}]"
            )
        mix_inputs = "".join(f"[n{i}]" for i in range(idx))
        filter_complex = "; ".join(filter_parts + norm_parts)
        filter_complex += (
            f"; {mix_inputs}amix=inputs={idx}:duration=longest:normalize=1"
            f",alimiter=limit=1:attack=3:release=50[out]"
        )

        output_path = room_dir / "mixdown.mp3"
        cmd = ["ffmpeg", "-y"] + inputs + [
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-b:a", "192k",
            str(output_path),
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                print(f"[Multiplayer] Mixdown failed: {result.stderr[-500:]}")
                return JSONResponse({"error": "Mixdown failed"}, 500)
        except Exception as e:
            print(f"[Multiplayer] Mixdown error: {e}")
            return JSONResponse({"error": str(e)}, 500)

        room["mixdown_path"] = str(output_path)
        await _broadcast(room, {
            "type": "mixdown_ready",
            "url": f"/api/plugins/multiplayer/rooms/{code}/mixdown",
        })
        return {"ok": True, "url": f"/api/plugins/multiplayer/rooms/{code}/mixdown"}

    @app.get("/api/plugins/multiplayer/rooms/{code}/mixdown")
    async def download_mixdown(code: str):
        room = _rooms.get(code.upper())
        if not room or not room.get("mixdown_path"):
            return JSONResponse({"error": "No mixdown available"}, 404)
        path = Path(room["mixdown_path"])
        if not path.exists():
            return JSONResponse({"error": "Mixdown file not found"}, 404)
        return FileResponse(str(path), media_type="audio/mpeg", filename="mixdown.mp3")

    # ── Mixer: list tracks + serve individual audio files ───────────────

    @app.get("/api/plugins/multiplayer/rooms/{code}/tracks")
    async def list_tracks(code: str):
        """Return all available audio tracks (stems + recordings) for the mixer."""
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)

        tracks = []

        # Song stems
        if 0 <= room["now_playing"] < len(room["queue"]):
            queue_item = room["queue"][room["now_playing"]]
            filename = queue_item.get("filename", "")
            if filename and callable(_get_dlc_dir):
                dlc = _get_dlc_dir()
                if dlc:
                    song_path = dlc / filename
                    if song_path.exists():
                        try:
                            import sloppak as sloppak_mod
                            if sloppak_mod.is_sloppak(song_path):
                                cache_dir = context.get("get_sloppak_cache_dir", lambda: None)()
                                source_dir = sloppak_mod.resolve_source_dir(filename, dlc, cache_dir)
                                manifest = sloppak_mod.load_manifest(song_path)
                                stems = manifest.get("stems", []) or []
                                for s in stems:
                                    if isinstance(s, dict) and s.get("file"):
                                        stem_path = source_dir / s["file"]
                                        if stem_path.exists():
                                            tracks.append({
                                                "id": s.get("id", ""),
                                                "label": s.get("id", "stem"),
                                                "type": "stem",
                                                "url": f"/api/plugins/multiplayer/rooms/{code}/track/{stem_path.name}?dir={stem_path.parent}",
                                                "path": str(stem_path),
                                            })
                        except Exception:
                            pass

        # Player recordings
        for pid, rec_info in room["recordings"].items():
            rec_path = rec_info["path"] if isinstance(rec_info, dict) else rec_info
            start_ms = rec_info.get("start_ms", 0) if isinstance(rec_info, dict) else 0
            if Path(rec_path).exists():
                player_name = room["players"].get(pid, {}).get("name", pid[:8])
                tracks.append({
                    "id": f"rec_{pid}",
                    "label": f"{player_name} (recording)",
                    "type": "recording",
                    "player_id": pid,
                    "start_ms": start_ms,
                    "url": f"/api/plugins/multiplayer/rooms/{code}/track/{Path(rec_path).name}",
                    "path": str(rec_path),
                })

        return {"tracks": tracks}

    @app.get("/api/plugins/multiplayer/rooms/{code}/track/{filename}")
    async def serve_track(code: str, filename: str, dir: str = ""):
        """Serve an individual audio file for the mixer preview."""
        room = _rooms.get(code.upper())
        if not room:
            return JSONResponse({"error": "Room not found"}, 404)

        # Check recordings in room dir
        room_dir = MP_DIR / code.upper()
        track_path = room_dir / filename
        if track_path.exists():
            mt = "audio/wav" if filename.endswith(".wav") else "audio/ogg"
            return FileResponse(str(track_path), media_type=mt)

        # Check stem dir
        if dir:
            stem_path = Path(dir) / filename
            if stem_path.exists():
                mt = "audio/ogg" if filename.endswith(".ogg") else "audio/wav"
                return FileResponse(str(stem_path), media_type=mt)

        return JSONResponse({"error": "Track not found"}, 404)

    # ── WebSocket ──────────────────────────────────────────────────────

    @app.websocket("/ws/plugins/multiplayer/{code}")
    async def multiplayer_ws(websocket: WebSocket, code: str, player_id: str = ""):
        await websocket.accept()

        code = code.upper()
        room = _rooms.get(code)
        if not room or player_id not in room["players"]:
            await websocket.send_json({"type": "error", "message": "Invalid room or player"})
            await websocket.close()
            return

        player = room["players"][player_id]
        player["ws"] = websocket
        player["connected"] = True
        player["last_seen"] = time.monotonic()

        # Cancel cleanup if reconnecting
        task = _cleanup_tasks.pop(code, None)
        if task:
            task.cancel()

        # Send full room state
        await websocket.send_json({
            "type": "connected",
            "room": _serialize_room(room),
            "server_time": time.monotonic() * 1000,
        })

        # Notify others
        await _broadcast(room, {
            "type": "player_connected",
            "player_id": player_id,
            "name": player["name"],
        }, exclude=player_id)

        try:
            while True:
                data = await websocket.receive_json()
                await _handle_message(room, player_id, data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[Multiplayer] WS error for {player_id}: {e}")
        finally:
            player["connected"] = False
            player["ws"] = None
            await _broadcast(room, {
                "type": "player_disconnected",
                "player_id": player_id,
            })
            # Check if room needs cleanup
            if _connected_count(room) == 0:
                _start_cleanup(code)

    async def _handle_message(room, player_id, data):
        msg_type = data.get("type", "")
        is_host = room["host"] == player_id
        server_time = time.monotonic() * 1000

        if msg_type == "clock_sync_request":
            ws = room["players"][player_id].get("ws")
            if ws:
                await ws.send_json({
                    "type": "clock_sync_response",
                    "client_t1": data.get("client_t1", 0),
                    "server_t2": server_time,
                    "server_t3": time.monotonic() * 1000,
                })

        elif msg_type == "set_arrangement":
            player = room["players"].get(player_id)
            if player:
                player["arrangement"] = data.get("arrangement", "Lead")
                await _broadcast(room, {
                    "type": "arrangement_changed",
                    "player_id": player_id,
                    "arrangement": player["arrangement"],
                })

        elif msg_type == "play" and is_host:
            room["state"] = "playing"
            room["time"] = data.get("time", 0.0)
            room["speed"] = data.get("speed", 1.0)
            await _broadcast(room, {
                "type": "playback_state",
                "state": "playing",
                "time": room["time"],
                "speed": room["speed"],
                "server_time": server_time,
            }, exclude=player_id)

        elif msg_type == "pause" and is_host:
            room["state"] = "paused"
            room["time"] = data.get("time", 0.0)
            await _broadcast(room, {
                "type": "playback_state",
                "state": "paused",
                "time": room["time"],
                "speed": room["speed"],
                "server_time": server_time,
            }, exclude=player_id)

        elif msg_type == "seek" and is_host:
            room["time"] = data.get("time", 0.0)
            await _broadcast(room, {
                "type": "playback_state",
                "state": room["state"],
                "time": room["time"],
                "speed": room["speed"],
                "server_time": server_time,
            }, exclude=player_id)

        elif msg_type == "set_speed" and is_host:
            room["speed"] = data.get("speed", 1.0)
            await _broadcast(room, {
                "type": "playback_state",
                "state": room["state"],
                "time": room["time"],
                "speed": room["speed"],
                "server_time": server_time,
            }, exclude=player_id)

        elif msg_type == "heartbeat" and is_host:
            room["time"] = data.get("time", room["time"])
            await _broadcast(room, {
                "type": "heartbeat",
                "time": room["time"],
                "state": room["state"],
                "server_time": server_time,
            }, exclude=player_id)

        elif msg_type == "start_recording" and is_host:
            room["recording"] = True
            room["recordings"] = {}
            await _broadcast(room, {"type": "recording_state", "recording": True})

        elif msg_type == "stop_recording" and is_host:
            room["recording"] = False
            await _broadcast(room, {"type": "recording_state", "recording": False})

        elif msg_type == "song_ended" and is_host:
            room["skip_votes"] = set()
            await _advance_song(room)

        elif msg_type == "load_song" and is_host:
            # Host explicitly starts a song from queue
            index = data.get("index", 0)
            if 0 <= index < len(room["queue"]):
                room["now_playing"] = index
                room["state"] = "stopped"
                room["time"] = 0.0
                room["recording"] = False
                room["recordings"] = {}
                room["mixdown_path"] = None
                room["skip_votes"] = set()
                await _broadcast(room, {
                    "type": "song_changed",
                    "now_playing": room["now_playing"],
                    "queue_item": room["queue"][room["now_playing"]],
                }, exclude=player_id)

    async def _advance_song(room):
        """Move to next song in queue."""
        room["state"] = "stopped"
        room["time"] = 0.0
        room["skip_votes"] = set()
        room["recordings"] = {}
        room["mixdown_path"] = None

        if room["now_playing"] < len(room["queue"]) - 1:
            room["now_playing"] += 1
            await _broadcast(room, {
                "type": "song_changed",
                "now_playing": room["now_playing"],
                "queue_item": room["queue"][room["now_playing"]],
            })
        else:
            room["now_playing"] = -1
            await _broadcast(room, {
                "type": "queue_finished",
                "now_playing": -1,
            })

    def _start_cleanup(code):
        """Start 60s grace period before destroying a room."""
        if code in _cleanup_tasks:
            return
        _cleanup_tasks[code] = asyncio.ensure_future(_cleanup_after_grace(code))

    async def _cleanup_after_grace(code, seconds=60):
        await asyncio.sleep(seconds)
        room = _rooms.get(code)
        if room and _connected_count(room) == 0:
            del _rooms[code]
            # Clean up files
            room_dir = MP_DIR / code
            if room_dir.exists():
                shutil.rmtree(str(room_dir), ignore_errors=True)
            print(f"[Multiplayer] Room {code} destroyed after grace period")
        _cleanup_tasks.pop(code, None)
