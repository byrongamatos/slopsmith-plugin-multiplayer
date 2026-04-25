# Multiplayer Plugin — Wire Protocol

This document describes the wire protocol used by the Slopsmith Multiplayer plugin. Two WebSocket endpoints are exposed:

- **Highway WS** — `/ws/plugins/multiplayer/{code}` — JSON control plane (already implemented; see `routes.py`).
- **Audio WS** — `/ws/plugins/multiplayer/{code}/audio` — binary peer-audio relay. Planned for the interval-quantized peer-audio feature; not live in any released plugin version yet. `plugin.json` stays at the current version until the endpoint actually ships.

Both endpoints share the same room registry and authentication state: the connecting client must pass `player_id` as a query parameter, the room must exist, and the player must already be a member of the room (joined via the REST API). The two endpoints use different rejection mechanisms because their framing rules differ — see each endpoint section below.

---

## Endpoints

### Highway WS — JSON control plane

```
ws://<host>/ws/plugins/multiplayer/{code}?player_id={id}
```

Carries all control messages. The message types used by the audio feature are documented under "Audio control messages" below; the existing playback/queue/recording messages are unchanged.

**Rejection on auth failure:** the highway WS sends a JSON `{"type": "error", "message": "..."}` text frame and then closes the connection (existing behavior; preserves backward compatibility with already-shipped clients).

### Audio WS — binary peer-audio relay (NEW)

```
ws://<host>/ws/plugins/multiplayer/{code}/audio?player_id={id}
```

Carries **binary frames only**. Every frame is one full Ninjam-style interval of Opus-encoded audio.

The server's forwarding path is intentionally trivial: on receipt of a binary frame from a subscriber, it forwards the frame **byte-for-byte** to every other audio subscriber in the same room — no re-encoding, no payload inspection, no rewriting. The server DOES, however, parse the fixed-size 40-byte header before forwarding in order to enforce the safety checks in "Frame size budget and bounds" below (magic, version, frame-length / `opus_size` consistency, and the `MAX_FRAME_BYTES` hard limit). Those are O(1) integrity checks on the header only; the Opus payload is never touched.

**The audio WS is binary-only in BOTH directions in v1.** Neither client nor server may send text/JSON frames over it. Specifically:

- Clients MUST NOT send text frames. If the server receives a non-binary frame, it MUST drop it and MUST NOT forward it to any peer. (Servers MAY additionally close the connection on receipt of a non-binary frame; v1 implementations are not required to.)
- Servers MUST NOT send text frames either. **Connection-rejection on auth failure (room not found, player not in room) is signalled via the WebSocket close handshake only**, with one of the close codes below — no JSON error payload as on the highway WS. This preserves the binary-only invariant and lets clients implement a single uniform reader.

| Close code | Meaning                                                             |
|-----------:|---------------------------------------------------------------------|
| `4401`     | Auth failure (room does not exist or `player_id` not in the room).  |
| `4409`     | Superseded — another connection for the same `player_id` took over (see "v1 server policy" below). |
| `1009`     | Frame too big — see Frame size budget and bounds below.             |
| `1011`     | Server error (unexpected; rare).                                    |

**v1 server policy: at most one active connection per `player_id` for EACH WS endpoint** (highway and audio independently). When a new connection arrives for a `player_id` that already has an active connection on the same endpoint, the server MUST cleanly close the existing connection (close code `4409`, reason `"superseded"`) before accepting the new one — most-recent-wins semantics. The closed-out tab's WebSocket fires `close` with code `4409`; clients seeing `4409` MUST treat it as "another tab took over" and tear down their broadcast/listener state cleanly (no error UI, since this is the user's own action elsewhere).

This rule applies symmetrically to BOTH the highway WS and the audio WS:

- Without it on the audio WS, a duplicate connection would race with the listener's "first-frame" readiness signal.
- Without it on the highway WS, a duplicate tab could receive `broadcaster_changed` events for the shared `player_id` even though its own audio WS does not exist or was superseded.

Phase 1 will tighten the existing highway WS handler in `routes.py` to enforce the same rule (today it overwrites `player["ws"]` without closing the old socket; that becomes a bug under the new audio feature).

As a corollary of this policy, `broadcaster_id` (= `player_id`) uniquely identifies BOTH the host's audio WS and the host's highway WS at any moment in time — no per-tab session token is required. The `4401` close code remains for auth failures (room/player_id invalid) and uses the accept-then-close pattern documented above. v1 servers MUST NOT use any close code outside `{4401, 4409, 1009, 1011}` on the audio WS.

Codes in the `4000–4999` range are protocol-reserved per RFC 6455 and visible to the client via `event.code` on the `close` event. The optional `event.reason` string MAY include a short ASCII hint (≤ 123 bytes per RFC) but clients MUST NOT depend on a specific reason string.

**Implementation note (server side).** To make the typed close code actually reach the browser, the server MUST accept the WebSocket upgrade first and only then close with the custom code. On Starlette / FastAPI, `await websocket.close(code=4401)` *before* `await websocket.accept()` causes the HTTP upgrade to fail with `403 Forbidden`, and browser clients receive a generic `WebSocket` error rather than a `close` event whose `event.code === 4401`. The required pattern is:

```python
@app.websocket("/ws/plugins/multiplayer/{code}/audio")
async def audio_ws(websocket: WebSocket, code: str, player_id: str = ""):
    await websocket.accept()                 # accept first
    if not _is_authorised(code, player_id):
        await websocket.close(code=4401)     # then close with typed code
        return
    # ... normal session ...
```

**Implementation note (client side).** A direct consequence of accept-then-close is that **the audio WS `open` event is NOT proof that authentication succeeded.** A rejected socket fires `open` first and only then `close` with code `4401`. Treating `open` alone as "ready" — for example, enabling broadcaster UI or starting a send loop in the open handler — will mis-handle rejected connections, and there is no fixed timeout that closes this race deterministically (close delivery is not bounded under network stall).

The deterministic readiness signal for the audio WS comes from the **control plane on the highway WS**, not from the audio WS itself:

- **Host (sender).** Treat the audio WS as ready for outbound audio only after the server has acknowledged `broadcast_start` by emitting `broadcaster_changed` on the highway WS with the host's own `broadcaster_id`. If the audio WS was rejected with `4401`, the server's broadcaster registry will not contain the host's audio subscriber, and the server MUST refuse `broadcast_start` from that host (returning `{"type":"error","message":"audio_ws_not_open"}` on the highway WS). Combined with the one-audio-WS-per-player_id server policy above, the `broadcaster_changed` ack uniquely identifies the host's own audio WS. UI that begins capture or sending MUST be gated on the `broadcaster_changed` ack, not on the audio WS `open` event.
- **Listener.** The user-visible "broadcast active" state comes from EITHER the initial `connected` room snapshot's `broadcaster_id` (for late joiners — clients that join while a broadcast is already in progress) OR a fresh `broadcaster_changed` event (for clients in the room when the broadcast starts). Both are valid signals; UI MUST treat them equivalently. The user-visible "audio is actually flowing" state is the **first valid binary frame** arriving on the audio WS; the listener's audio graph (decoder, gain node, scheduling) is constructed on receipt of that first frame. **Listeners MUST NOT use the audio WS `open` event for any UI or readiness purpose** — including clearing a "connecting…" indicator — because under the accept-then-close pattern, a rejected socket fires `open` first and `close(4401)` may be delivered arbitrarily later.

This anchors readiness on the already-authenticated highway WS (which uses the existing JSON-error-then-close rejection path) plus deterministic data-plane events (first frame received) — never on audio WS `open`, which is racy for both auth-failure (`4401`) and is the canonical race source codex flagged.

---

## Audio control messages (Highway WS)

These flow over the existing highway WebSocket.

### `broadcast_start` — host announces it is broadcasting

Sent by a client to the server when its user enables the broadcast toggle.

```json
{
  "type": "broadcast_start",
  "interval_beats": 4,
  "sample_rate": 48000,
  "channel_count": 1,
  "codec": "opus",
  "bitrate": 96000
}
```

Server response — broadcast to all peers in the room:

```json
{
  "type": "broadcaster_changed",
  "broadcaster_id": "ab12cd34",
  "interval_beats": 4,
  "sample_rate": 48000,
  "channel_count": 1,
  "codec": "opus",
  "bitrate": 96000
}
```

Server also stores `broadcaster_id` (and the codec parameters) in the room dict; subsequent `_serialize_room` snapshots include them so late-joiners learn about the active broadcast immediately on `connected`.

v1 enforces a single broadcaster per room. A second `broadcast_start` from a different player while one is already active is rejected with:

```json
{ "type": "error", "message": "broadcaster_busy" }
```

### `broadcast_stop` — host stops broadcasting

```json
{ "type": "broadcast_stop" }
```

Server response — broadcast to all peers:

```json
{ "type": "broadcaster_changed", "broadcaster_id": null }
```

A disconnect on the audio WS by the broadcaster has the same effect.

### `audio_quality` — listener-reported telemetry (optional)

Periodic peer-side report so the broadcaster's UI can display "N late frames in last 30s" etc. Forwarded to all peers (or just to the broadcaster — TBD during Phase 3).

```json
{
  "type": "audio_quality",
  "broadcaster_id": "ab12cd34",
  "intervals_received": 120,
  "intervals_late": 3,
  "intervals_dropped": 0,
  "decoder_underruns": 0,
  "report_period_ms": 30000
}
```

---

## Audio frame format (Audio WS)

Every audio WS binary frame consists of a fixed-size header followed by the Opus payload. All multi-byte integer fields are **little-endian**. All floating-point fields are IEEE 754 little-endian.

### Header layout (40 bytes)

| Offset | Size | Type    | Field               | Description                                                                                  |
|-------:|-----:|---------|---------------------|----------------------------------------------------------------------------------------------|
|   0    |   4  | char[4] | `magic`             | ASCII `"SMAU"` (Slopsmith Multiplayer AUdio). Frame is rejected if mismatched.               |
|   4    |   2  | u16     | `version`           | Protocol version. v1 = `1`. v1 receivers MUST drop frames where `version != 1`. (Forward-compat handling for specific known-newer versions can be defined in later revisions of this spec.) |
|   6    |   2  | u16     | `flags`             | Bit field. Bit 0 = `tempo_change_at_end` (this interval ends on a tempo change). Other bits reserved; receivers MUST treat them as 0. |
|   8    |   8  | u64     | `interval_index`    | Monotonically increasing, scoped per broadcaster per session. Wraps after `2^64 − 1` (rolls over to `0`) — never in practice. JavaScript receivers MUST parse this as `BigInt` (e.g. `DataView.getBigUint64`) rather than `Number`, since `Number` loses precision above `2^53 − 1`. |
|  16    |   8  | f64     | `chart_time_start`  | Chart playback time (seconds) at which this interval's first sample was captured.            |
|  24    |   8  | f64     | `chart_time_end`    | Chart playback time **immediately after** this interval's last sample (end-exclusive). `chart_time_end - chart_time_start` is the interval's authoritative wall-clock duration in seconds; `chart_time_end` of frame N equals `chart_time_start` of frame N+1 when intervals are contiguous. |
|  32    |   4  | u32     | `sample_count`      | Number of PCM samples encoded into the Opus payload (per channel). **Hint only** — receivers MUST validate against the duration-derived cap (see "Receiver validation" below) before using this value to size any allocation, and SHOULD treat the decoder's actual output as authoritative. |
|  36    |   4  | u32     | `opus_size`         | Size of the Opus payload in bytes. Receiver must verify `frame_length == 40 + opus_size`.    |

### Payload

The byte range `[40, 40 + opus_size)` (half-open — offset 40 inclusive, `40 + opus_size` exclusive) is an Opus-encoded chunk produced by the WebCodecs `AudioEncoder` configured as:

```js
{
  codec: "opus",
  sampleRate: 48000,
  numberOfChannels: 1,    // v1: mono only
  bitrate: 96000,
  opus: { application: "audio" }
}
```

The chunk is the entire interval (not a sequence of small frames). Encoder is `flush()`ed at each interval boundary so a single `EncodedAudioChunk` represents the whole interval.

### Frame size budget and bounds

A 2-second interval at 96 kbps Opus ≈ 24 KB of audio + 40 bytes of header = ~24 KB per frame. Even worst-case slow ballads (30 BPM × 4 beats = 8 s interval) cap out around ~96 KB.

**Hard limit (DoS bound): `MAX_FRAME_BYTES = 262144` (256 KB), inclusive of header.** This is roughly 2× the worst-case legitimate frame, so well-behaved clients will never approach it.

- Senders MUST NOT emit a frame larger than `MAX_FRAME_BYTES`.
- Servers MUST drop any frame larger than `MAX_FRAME_BYTES` (no fan-out) and SHOULD close the offending audio WS with status code `1009` (Message Too Big).
- Servers MUST also reject frames where `frame_length < 40` (header truncation) or where `40 + opus_size != frame_length` (header/body mismatch), with the same drop-and-close behavior.

This bound is the primary backpressure / abuse defense for the relay, since the server otherwise does no payload inspection.

### Receiver validation (defense against malicious peers)

The server forwards binary frames byte-for-byte from one peer to another, so receivers MUST treat header fields — and the broadcaster-asserted parameters in `broadcast_start` — as untrusted input. All checks below are O(1) and MUST be performed before any allocation or decoder call.

**v1 hard limits (constant, not derived from peer-supplied data):**
- `V1_SAMPLE_RATE = 48000` — the only sample rate v1 supports.
- `V1_CHANNEL_COUNT = 1` — mono only in v1.
- `MAX_INTERVAL_SEC = 32` — duration cap. (Generous; even 30 BPM × 8 beats is only 16 seconds.)
- `MAX_SLACK_SAMPLES = 480` — ~10 ms at 48 kHz, to account for Opus packetization padding when bounding `sample_count`.

**Control-plane validation (`broadcast_start` JSON).** Receivers MUST reject (and SHOULD disconnect the audio WS from) any `broadcast_start` where:
- `sample_rate != V1_SAMPLE_RATE`, or
- `channel_count != V1_CHANNEL_COUNT`, or
- `codec != "opus"`, or
- `bitrate` is missing, non-finite, or outside `[16_000, 256_000]`.

Future protocol versions may relax these constraints; v1 receivers reject everything else so the allocation bounds below can use trusted constants.

**Per-frame validation (binary header).** Receivers MUST drop frames where any of the following holds:
- `magic != "SMAU"` or `version != 1` (already covered above).
- `chart_time_start` is not finite (i.e. `NaN` or `±Infinity`).
- `chart_time_end` is not finite.
- `(chart_time_end - chart_time_start)` is not finite, is `≤ 0`, or exceeds `MAX_INTERVAL_SEC`.
- `sample_count > ceil(V1_SAMPLE_RATE * (chart_time_end - chart_time_start)) + MAX_SLACK_SAMPLES`. This bound uses the v1 constant `V1_SAMPLE_RATE`, not any peer-supplied sample rate, so the limit cannot be enlarged by a malicious broadcaster.
- `opus_size + 40 != frame_length` (header/body mismatch — should already have been caught by the server, but receivers SHOULD re-validate independently).

**Note:** `sample_count` is a *hint* for pre-allocating the decoder's output `AudioBuffer`. The canonical sample count for actual playback is whatever the decoder produces; receivers SHOULD treat the decoder output as authoritative and reserve `sample_count` purely for buffer pre-sizing.

---

## Interval-selection algorithm

The host picks the interval length from the chart's BPM, deterministically, and advertises it in `broadcast_start.interval_beats`. This value is **metadata only** — it tells listeners the broadcaster's chosen unit so the UI can label intervals, but listeners **MUST NOT** use it to compute frame-by-frame playback duration. Each frame's authoritative duration is `chart_time_end − chart_time_start` (see Lifecycle §4 below). This is what survives mid-song tempo changes correctly: a single frame that straddles a tempo change has a duration the broadcaster already measured at capture time, which differs from a naive `interval_beats × 60 / bpm` calculation.

The algorithm only ever returns a **whole-measure** value (4 beats in 4/4) or a **two-measure** value (8 beats). It never returns sub-measure intervals — half-measure boundaries do not align with the natural musical pulse a player feels, which makes the previous-interval recording feel jagged rather than locked-in.

```
function selectInterval(bpm):
    if bpm <= 0 or not finite:
        return 4                         # safety default
    secondsPerBeat = 60 / bpm
    if 4 * secondsPerBeat < 1.0:         # very fast: one measure < MIN
        return 8
    return 4                             # default: one measure
```

Decision table:

| BPM range     | Interval (beats) | Duration         | Notes                                              |
|---------------|------------------|------------------|----------------------------------------------------|
| ≤ 240         | 4                | ≥ 1.0 s          | Default. One measure of 4/4.                       |
| > 240         | 8                | depends on BPM   | One measure shrinks below 1.0 s; bump to 2 measures. |
| invalid (≤ 0) | 4                | n/a              | Safety default.                                    |

For very slow songs (e.g. 60 BPM → 4.0 s/measure, 30 BPM → 8.0 s/measure) the interval exceeds the soft 3.0 s target. v1 accepts that — a longer-than-target whole measure is musical; a half-measure is not. v2 may add 2-measure-default behavior at slow tempos if the longer "previous interval" delay turns out to feel sluggish in practice.

The constants `MIN_DURATION_SEC = 1.0`, `DEFAULT_BEATS = 4`, and `FAST_TEMPO_BEATS = 8` live in `audio/select-interval.js`. A pure-Node test file `audio/select-interval.test.js` validates the algorithm with no test-framework dependency: `node audio/select-interval.test.js`.

The helper is currently CommonJS-only because slopsmith core's plugin loader serves only `/api/plugins/{id}/screen.js` (one entry point per plugin) — no generic asset path. Phase 2 will inline the helper into `screen.js` when the broadcast/listen pipelines need it browser-side.

---

## Lifecycle

1. **Room join (existing).** Client `POST`s to `/api/plugins/multiplayer/rooms/{code}/join`, then opens the highway WS.
2. **Audio WS open.** Any time after the highway WS connects, the client opens the audio WS. v1: clients open it eagerly on room join so that broadcasts can start instantly.
3. **Broadcast.** A user toggles "broadcast my sound." The client sends `broadcast_start` on the highway WS. Server validates, stores `broadcaster_id`, broadcasts `broadcaster_changed` to all peers. The client begins streaming binary frames on the audio WS.
4. **Listen.** Every other peer's listener pipeline activates on receipt of `broadcaster_changed` (with non-null id). It listens for binary frames on the audio WS, decodes, and schedules playback using the frame's authoritative interval duration: the next-interval start is `chart_time_end` (and the playable duration is `chart_time_end − chart_time_start`). Listeners MUST NOT compute the interval boundary from `interval_beats × 60 / bpm`, because that calculation breaks when a tempo change occurs inside or at the boundary of an interval; the frame header is the single source of truth.
5. **Stop.** Broadcaster sends `broadcast_stop` (or disconnects audio WS). Server clears `broadcaster_id`, broadcasts `broadcaster_changed` with `null`. Listeners drain pending intervals and tear down their audio graph.
6. **Pause/seek (existing host control).** Existing playback semantics apply: when the host pauses, all clients pause. Listeners must `.stop()` any in-flight `AudioBufferSourceNode`s when the chart pauses, and rebuild the playback queue against the new chart time when playback resumes (since pending buffers may now schedule into the past or future incorrectly).
7. **Room teardown.** Existing 60-second grace period applies to both WS endpoints. Audio subscribers are dropped on player disconnect; if the dropped player was the broadcaster, the room is updated and peers notified.

---

## Versioning

The header `version` field exists so future revisions (e.g. stereo support, per-frame Opus packets instead of one-chunk-per-interval) can extend the format. v1 receiver requirements:

- MUST reject frames with `magic != "SMAU"`.
- MUST drop frames where `version != 1`. (Forward-compat handling for specific known-newer versions can be defined in later revisions of this spec; v1 takes the conservative drop-everything-unknown stance.)
- MUST treat unknown bits in `flags` as 0.

The control-message protocol uses the existing `"type"` discriminator and is forward-compatible: unknown types are logged-and-ignored by both ends.
