# Implementation Plan — Multiplayer

The largest plugin in the Slopsmith ecosystem. PROTOCOL.md is the
normative spec for the wire format; this plan documents how the code
implements it.

## Files

- `plugin.json` — id `multiplayer`, GPL-3.0-or-later, declares
  screen / script / routes.
- `routes.py` (2134 lines) — backend: room registry, REST routes,
  highway WS, audio WS, mixdown.
- `screen.html` (272 lines) — multiplayer panel UI.
- `screen.js` (5107 lines) — entire frontend: room UI, queue,
  recording, mixer, listener pipeline, broadcast capture pipeline
  (audio modules from `audio/*.js` are inlined into this file
  because the loader serves only `screen.js`).
- `PROTOCOL.md` (367 lines) — wire protocol normative spec.
- `TESTING.md` (230 lines) — manual two-machine LAN test matrix.
- `audio/` — source-of-truth modules for inlined helpers
  (`smau-frame.js`, `select-interval.js`, `tempo-change.js`,
  `audio-capture-worklet.js`) plus `*.test.js` unit tests.
- `tests/` — pytest suite covering session lifecycle, audio WS,
  broadcast control plane.
- `pyproject.toml`, `requirements-test.txt` — dev dependencies.

## Backend (`routes.py`)

### Module-level state

- `_rooms: dict[str, dict]` — code → room dict.
- `_cleanup_tasks: dict[str, asyncio.Task]` — pending 60 s
  cleanup tasks, keyed by code.
- `_MP_DIR: Path` — set by `setup()`; recordings + mixdowns live
  here.

### Lifecycle constants

```
SESSION_GRACE_SEC = 5.0
HOST_CREATOR_GRACE_SEC = 30.0
_PURGE_TIMEOUT_SEC = 0.5
_AUDIO_FRAME_HEADER_LEN = 40
_AUDIO_FRAME_MAX_BYTES = 262144
_AUDIO_SEND_QUEUE_MAX = 8
_V1_SAMPLE_RATE = 48000
_V1_CHANNEL_COUNT = 1
_V1_CODEC = "opus"
_V1_BITRATE_MIN, _V1_BITRATE_MAX = 16000, 256000

# Close codes (PROTOCOL.md)
_CLOSE_AUTH_FAIL       = 4401
_CLOSE_GRACE_EXPIRED   = 4408
_CLOSE_SUPERSEDED      = 4409
_CLOSE_REPLACED        = 4410
_CLOSE_FRAME_TOO_BIG   = 1009
_CLOSE_NORMAL          = 1000
_CLOSE_INTERNAL_ERROR  = 1011
```

### Room dict shape (live state)

```
{
  "code": str,
  "host_id": str,
  "creator_id": str,                  # initial host before any WS connects
  "players": {player_id: {...}},
  "sessions": {                       # PROTOCOL.md "v1 server policy"
     player_id: {
       "session_id": str,
       "highway_ws": ws | None,
       "audio_ws":   ws | None,
     },
  },
  "queue": [...],
  "broadcaster_id": str | None,
  "broadcast_params": {sample_rate, channel_count, codec, bitrate},
  ...
}
```

### Endpoints

| Path | Type | Role |
|---|---|---|
| `/api/plugins/multiplayer/rooms` | POST | Create room. |
| `/api/plugins/multiplayer/rooms/<code>/join` | POST | Mint `player_id`. |
| `/api/plugins/multiplayer/rooms/<code>/leave` | POST | Voluntary leave. |
| `/api/plugins/multiplayer/rooms/<code>/queue` | POST/GET/DELETE | Shared queue. |
| `/api/plugins/multiplayer/rooms/<code>/recordings` | POST (UploadFile) | Per-player track upload. |
| `/api/plugins/multiplayer/rooms/<code>/mixdown` | POST | FFmpeg mixdown with offsets/volumes/mutes. |
| `/ws/plugins/multiplayer/{code}` | WS | Highway control plane (JSON). |
| `/ws/plugins/multiplayer/{code}/audio` | WS | Binary peer audio relay. |

(Full endpoint list is larger; this captures the architectural
shape.)

### Audio frame handling

- On binary frame receipt: parse 40-byte header (magic check,
  version check, `opus_size + 40 == len(frame)` check), drop on
  fail, close 1009 on size-cap violation.
- Forward byte-for-byte to every other audio subscriber in the
  room.
- Per-listener queue capped at 8; oldest dropped on overflow.
- `broadcast_start` validation: codec / sample rate / channels /
  bitrate against v1 constants.

### Session FSM

Per PROTOCOL.md §"Connection-arrival rules":

1. No existing session → create + register slot.
2. Same `session_id` → close existing slot with 4410, register new.
3. Different `session_id` → close BOTH old slots with 4409,
   replace.

Per-endpoint grace: when a slot becomes empty, start a 5 s timer.
On expiry close the OTHER slot with 4408 and discard the session.

## Frontend (`screen.js`)

Single 5,100-line IIFE. Major sections (in order, by approximate
top-to-bottom layout):

1. State globals (`_ws`, `_audioWs`, `_roomCode`, `_playerId`,
   `_sessionId`, host flag, room dict, clock-sync state).
2. WS lifecycle: open / close / reconnect with independent timers
   per endpoint.
3. Highway sync: NTP-style clock sync (`pingMs` delta), drift
   correction via `playbackRate` micro-adjust, heartbeat loop.
4. Queue UI + REST helpers.
5. Recording: `getUserMedia`, `MediaRecorder`, upload at stop,
   server-time anchor for offsets.
6. Mixdown UI: waveform display, drag-to-align, nudge buttons,
   per-track mute / solo / volume, preview via Web Audio,
   server-side export.
7. Listener pipeline (peer audio in): WebCodecs `AudioDecoder` +
   `AudioBufferSourceNode` per interval scheduled at chart time;
   drop on pause / non-1.0× speed; refuse on out-of-bounds.
8. Broadcast pipeline (peer audio out): `getUserMedia` (no
   AGC/NS/AEC, 48 kHz mono) → inlined AudioWorklet → WebCodecs
   `AudioEncoder` Opus 96 kbps → SMAU frame build → audio WS send.
   `beforeunload` fires `broadcast_stop`.
9. Inlined audio modules (mirror of `audio/*.js`): SMAU codec,
   interval selector, tempo-change detection.

## Tests

### Backend (pytest)

- `tests/test_session_lifecycle.py` — session FSM (4408 / 4409 /
  4410), grace timers, host promotion.
- `tests/test_audio_ws.py` — binary fanout, SMAU header
  validation (1009), bounded queue.
- `tests/test_broadcast_control.py` — `broadcast_start /
  broadcast_stop / broadcaster_changed / broadcaster_busy /
  audio_quality`, single-broadcaster invariant.

### Frontend (node:test)

- `audio/smau-frame.test.js`, `audio/select-interval.test.js`,
  `audio/tempo-change.test.js` — pure helpers, run via the same
  Node `vm` pattern as `slopsmith-plugin-notedetect`.

### Manual

- `TESTING.md` — two-machine LAN matrix: sanity, hotspot/RTT,
  network drop, pause/seek, refresh, 30-min soak, tempo change,
  multi-broadcaster preemption.

## Integration with Slopsmith Core

- Player events (`song:loaded`, `song:ready`).
- `highway` instance for playback control + tone changes + beat
  grid.
- Library API for queue search.
- FFmpeg available in the Docker container (mixdown).
- `STATIC_DIR/sloppak_cache` for stem playback during sessions.

## Out of Scope / Deferred

- Multi-broadcaster mix (v2).
- Public room directory.
- Persistent rooms.
- E2E encryption.
- Voice chat.
