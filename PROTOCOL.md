# Multiplayer Plugin — Wire Protocol

This document describes the wire protocol used by the Slopsmith Multiplayer plugin. Two WebSocket endpoints are exposed:

- **Highway WS** — `/ws/plugins/multiplayer/{code}` — JSON control plane (already implemented; see `routes.py`).
- **Audio WS** — `/ws/plugins/multiplayer/{code}/audio` — binary peer-audio relay (introduced for the interval-quantized peer-audio feature, v1.1+).

Both endpoints share the same room registry and authentication: the connecting client must pass `player_id` as a query parameter, the room must exist, and the player must already be a member of the room (joined via the REST API). The audio WS rejects connections that fail this check the same way the highway WS does.

---

## Endpoints

### Highway WS — JSON control plane

```
ws://<host>/ws/plugins/multiplayer/{code}?player_id={id}
```

Carries all control messages. The message types used by the audio feature are documented under "Audio control messages" below; the existing playback/queue/recording messages are unchanged.

### Audio WS — binary peer-audio relay (NEW)

```
ws://<host>/ws/plugins/multiplayer/{code}/audio?player_id={id}
```

Carries **binary frames only**. Every frame is one full Ninjam-style interval of Opus-encoded audio.

The server's behavior is intentionally trivial: on receipt of a binary frame from a subscriber, it forwards the frame **byte-for-byte** to every other audio subscriber in the same room. The server never decodes, parses, or rewrites the frame body. Header parsing is the responsibility of the receiving client.

JSON / text frames on the audio WS are reserved for future use and are **not part of v1**. Clients **MUST NOT** send them. If the server receives a non-binary frame on the audio WS in v1, it **MUST drop the frame and MUST NOT forward it to any peer**. (Servers MAY additionally close the connection; v1 implementations are not required to.)

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
|  24    |   8  | f64     | `chart_time_end`    | Chart playback time at which the last sample was captured. `(end - start)` is the interval's wall-clock duration. |
|  32    |   4  | u32     | `sample_count`      | Number of PCM samples encoded into the Opus payload (per channel). Used by the decoder for AudioBuffer sizing. |
|  36    |   4  | u32     | `opus_size`         | Size of the Opus payload in bytes. Receiver must verify `frame_length == 40 + opus_size`.    |

### Payload

Bytes `40 .. 40 + opus_size` are an Opus-encoded chunk produced by the WebCodecs `AudioEncoder` configured as:

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
