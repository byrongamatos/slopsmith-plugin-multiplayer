# Feature Specification: Multiplayer Rooms

**Feature Branch**: `001-multiplayer`
**Created**: 2026-05-09 (retrospective)
**Status**: Implemented (v1.0.0). Peer audio broadcast = Phase 2d
shipped, Phase 2e (polish) in progress per PROTOCOL.md.
**Input**: `README.md`, `PROTOCOL.md`, `routes.py`, `screen.js`,
`audio/*`, `tests/`.

## User Scenarios & Testing

### User Story 1 — Create / join a synced room (P1)

As a player, I want to create a 6-character room code, share it with
friends, and have everyone's highway stay in sync (play / pause /
seek / speed) so we can practise the same song together.

**Why this priority**: Without synced rooms there is no plugin.

**Independent Test**: User A creates a room. User B joins with the
code. A picks a song and hits play; B's highway starts within ~50 ms
of A's playhead. A pauses; B pauses. A seeks; B follows.

**Acceptance Scenarios**:

1. **Given** a room exists, **When** a second player joins via
   `POST /api/plugins/multiplayer/rooms/<code>/join`, **Then** they
   receive a `connected` snapshot over the highway WS and start
   receiving `playback` heartbeats with NTP-style clock offset
   correction.
2. **Given** the host disconnects, **When** the grace window
   expires, **Then** the next-oldest player is promoted to host
   and the room remains alive.
3. **Given** the last player leaves, **When** 60 s elapse, **Then**
   the room is destroyed.

---

### User Story 2 — Shared song queue (P1)

As any player in the room, I want to add songs to a shared queue and
have it auto-advance when one finishes.

**Acceptance Scenarios**:

1. **Given** the room is live, **When** any player POSTs to add a
   song, **Then** all players see the queue update over the
   highway WS.
2. **Given** the current song ends, **When** the host signals end,
   **Then** the next queued song is loaded automatically.
3. **Given** a majority of players vote to skip, **When** the vote
   count reaches threshold, **Then** the song is skipped.

---

### User Story 3 — Per-player arrangement choice (P2)

As a player, I want to pick my own arrangement (Lead / Rhythm / Bass)
without affecting what other players see.

**Acceptance Scenarios**:

1. **Given** the room is live, **When** a player switches
   arrangement, **Then** only their highway re-renders; other
   players are unaffected.

---

### User Story 4 — Record + mix down per-player takes (P2)

As the host, I want to arm Record and have every player's mic / JUCE
input captured, then open a mini-DAW mixer afterwards to align each
take with the stems and export an MP3.

**Acceptance Scenarios**:

1. **Given** Record is armed, **When** the host hits play, **Then**
   recording starts on every player at the host's `recStartServerTime`.
2. **Given** recording stops, **When** each player uploads, **Then**
   the server saves a track per player.
3. **Given** the mixer is open, **When** the host clicks Export Mix,
   **Then** the server runs FFmpeg with the supplied offsets,
   volumes, and mutes and returns an MP3 download.

---

### User Story 5 — Live peer audio broadcast (P2)

As a broadcaster, I want one of my room peers to hear my instrument
playing through their browser, locked to the chart's beat grid (one
measure delayed), so we can hear each other while practising the same
chart.

**Why this priority**: Differentiating feature, but optional —
players who only want synced highways don't need it.

**Independent Test**: Two-machine LAN. User A picks a loopback input,
toggles "Broadcast my sound", User B sees a "Live audio: A"
indicator and hears A's playing one measure after A plays it. See
TESTING.md.

**Acceptance Scenarios**:

1. **Given** A is in the room, **When** A sends `broadcast_start`
   with valid params (Opus, 48 kHz, mono, 16k–256k bitrate), **Then**
   the server flips `broadcaster_id` to A and emits
   `broadcaster_changed` to all peers.
2. **Given** A is broadcasting, **When** B sends `broadcast_start`,
   **Then** A is preempted: A's clients receive `broadcaster_changed`
   with B's id, A's UI tears down capture cleanly.
3. **Given** A's audio frame exceeds 256 KB, **When** the server
   parses the SMAU header, **Then** the audio WS is closed with
   1009.
4. **Given** the chart pauses or `playbackRate != 1.0`, **When**
   inbound frames arrive, **Then** the listener pipeline drops
   them (counted under `listener_paused` / `listener_speed`).
5. **Given** B's session opens its second endpoint, **When** the
   audio WS connects, **Then** the highway WS is left untouched
   (close code `4410` only on the slot being replaced).

---

### User Story 6 — Cross-platform sessions (P3)

Web players and Slopsmith Desktop players can share a room. The wire
protocol is identical.

**Acceptance Scenarios**:

1. **Given** a desktop player and a web player in the same room,
   **When** both record, **Then** the desktop player's WAV and the
   web player's MediaRecorder webm-opus both arrive at the server
   and the latter is converted to WAV on upload.

## Functional Requirements

- **FR-001**: Room codes MUST be 6 chars from
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L).
- **FR-002**: Player IDs MUST be unique per room (`secrets.token_hex(8)`).
- **FR-003**: `session_id` syntax: `[A-Za-z0-9_-]{1,128}` — server
  MUST accept any value matching, MUST reject only missing /
  malformed values with close code 4401.
- **FR-004**: At most one active session per `(room_code, player_id)`
  identified by `session_id`.
- **FR-005**: Endpoint slot replacement MUST use close code 4410 on
  the replaced slot only; the other slot stays live.
- **FR-006**: Session takeover by a different `session_id` for the
  same `player_id` MUST close BOTH slots of the old session with
  4409.
- **FR-007**: Session-grace expiry on a missing endpoint MUST close
  BOTH slots with 4408. Grace = `SESSION_GRACE_SEC = 5.0`.
- **FR-008**: Audio frames MUST start with the 40-byte SMAU header
  (`b"SMAU"` magic, version `1`, plus per-frame timing / sequence
  fields). Server MUST validate magic, version, and
  `header.opus_size + 40 == frame_length` before forwarding. Max
  frame size 256 KB; violations close with 1009.
- **FR-009**: Server's audio forwarding path MUST NOT inspect or
  re-encode the Opus payload. Header validation only.
- **FR-010**: `broadcast_start` parameter validation: codec=`opus`,
  sample_rate=48000, channels=1, bitrate∈[16000, 256000]. Reject
  before flipping `broadcaster_id`.
- **FR-011**: Single broadcaster invariant: `broadcaster_id` is
  single-valued; new `broadcast_start` preempts cleanly via
  `broadcaster_changed`.
- **FR-012**: Listener queue MUST be bounded at 8 frames; oldest
  dropped on overflow.
- **FR-013**: Per-peer cleanup during broadcaster handoff MUST be
  capped at `_PURGE_TIMEOUT_SEC = 0.5` to avoid one slow listener
  gating the whole room's `broadcast_start`.
- **FR-014**: Host promotion: if the host disconnects and doesn't
  return within the grace window, the next player by join order is
  promoted. Creator who never connects yields the host slot to the
  first connected guest after `HOST_CREATOR_GRACE_SEC = 30.0`.
- **FR-015**: Rooms MUST be destroyed 60 s after the last player
  leaves; pending `_cleanup_tasks` cancelled on rejoin.
- **FR-016**: Recording: each player uploads a per-track file; the
  server stores under a per-room dir.
- **FR-017**: Mixdown: FFmpeg combines tracks with supplied
  `(offset, volume, mute)` per track and returns MP3.
- **FR-018**: Frontend MUST decode SMAU frames via WebCodecs
  `AudioDecoder` and schedule `AudioBufferSourceNode` per interval at
  `chartTimeStart + intervalDuration` translated into
  `AudioContext.currentTime` via the listener's chart audio
  element.
- **FR-019**: Tempo change at an interval boundary: broadcaster shows
  a "Tempo change at this measure" banner; the SMAU header carries
  `tempo_change_at_end` so future versions can time-stretch.
- **FR-020**: Audio capture pipeline: `getUserMedia` with
  `{echoCancellation: false, noiseSuppression: false,
  autoGainControl: false}`, 48 kHz mono, inlined
  `AudioWorkletProcessor`, level meter via `AnalyserNode`,
  WebCodecs `AudioEncoder` Opus 96 kbps, interval slicing keyed on
  the chart's BPM via the inlined `selectInterval` helper.

## Out of Scope

- Multi-broadcaster mixing in v1.
- Public room directory.
- Persistent rooms / queues / recordings across restarts.
- Voice chat (general-purpose, not chart-quantized).
- Speed-other-than-1.0× peer audio (chart→AudioContext mapping
  warps).
- E2E encryption of audio frames.
