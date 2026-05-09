# Clarifications — Multiplayer

## Q1. Why two WebSockets instead of one?

**A.** Framing rules differ: highway WS is JSON text frames with a
JSON-error rejection mechanism; audio WS is binary-only with
close-code-only rejection. Trying to multiplex them on a single WS
either forces JSON-encoding the audio (fatal for Opus throughput) or
forces clients to parse mixed frames (every audio frame would need
a discriminator). The split keeps both paths simple. PROTOCOL.md
states this normatively.

## Q2. Why does the client mint `session_id` instead of the server?

**A.** The server cannot tell "same tab opening its second endpoint"
from "different tab taking over" if both arrive as new connections
for the same `player_id`. Letting the client mint and persist
`session_id` (in `sessionStorage`) makes that distinction
deterministic. Server-side minting would require a round-trip before
the second endpoint connects.

## Q3. Why is the audio WS binary-only in BOTH directions?

**A.** Lets clients implement a single uniform binary reader. If the
server sent JSON error frames over the audio WS, clients would need
two parsers and two error paths. Close codes carry every signal the
audio WS needs (auth failure, supersession, replacement, frame too
big).

## Q4. Why does each listener have a queue cap of 8 frames?

**A.** Bounds memory on chronically slow listeners. At ~2 s
intervals and 96 kbps Opus, 8 frames ≈ 16 s of headroom — long
enough to absorb a transient network blip, short enough that a
resumed listener can catch up rather than fall arbitrarily behind.
New frames overwrite the oldest, which is the right policy for
audio (drop the late frame, keep the recent one).

## Q5. Why "one measure delayed" instead of the smallest-possible
buffer?

**A.** Borrowed from Ninjam. The chart audio is the shared anchor.
Each peer plays the chart in lockstep, and broadcasted audio plays
back **one interval** later — never "almost in sync, sometimes not."
This makes the experience deterministic regardless of network RTT
(LAN, Wi-Fi, tethered hotspot all feel identical) and lets the
broadcaster's interval finish before any listener tries to schedule
it.

## Q6. What is the SMAU header for if the server doesn't re-encode?

**A.** Three reasons. (1) Safety: `magic` / `version` /
`opus_size==frame_length-40` / 256 KB cap let the server reject
malformed or oversized frames in O(1) before fanout. (2) Listener
scheduling: chart time + interval duration are in the header so
listeners can schedule the `AudioBufferSourceNode` against
`AudioContext.currentTime` without a separate control message. (3)
Future-proofing: `tempo_change_at_end` flag lets future versions
time-stretch around tempo boundaries without a wire change.

## Q7. Why does broadcaster preemption use `broadcaster_changed`
rather than `broadcaster_busy`?

**A.** `broadcaster_busy` is the rejection from the server when a
client tries to start a broadcast that already has another
broadcaster *and* policy says no preemption. `broadcaster_changed`
is the success path: the new broadcaster takes over and all peers
(including the previous broadcaster) get the new
`broadcaster_id`. v1 always preempts.

## Q8. Why is `_PURGE_TIMEOUT_SEC = 0.5`?

**A.** During a broadcaster handoff, the server tries to flush each
listener's pending audio. A backpressured `ws.send_bytes` on one
slow listener should not gate `broadcast_start` for the rest of the
room. 0.5 s is empirically enough for healthy listeners and
short enough that one stuck listener doesn't visibly delay the
new broadcaster. The client-side `handoff_suppress` window catches
any stragglers that arrive after the timeout.

## Q9. Why are rooms ephemeral?

**A.** Multiplayer state is fundamentally session-scoped (people
practising right now). Persisting rooms / queues across restarts
would invite stale-state confusion (player IDs that mean nothing,
recordings that no one will claim) without obvious benefit. The
60-s grace exists only to absorb network blips on the last
remaining player.

## Q10. Why is multi-broadcaster mixing out of scope for v1?

**A.** Pre-mixed downstream audio at the server requires decoding
+ summing + re-encoding every frame, which 1) breaks the binary-only
"forward bytes" invariant, 2) puts decode/encode CPU on the server,
and 3) makes the failure modes harder to reason about (what does
"3 broadcasters but 2 are silent" mean for the listener?). v1
keeps the server as a dumb relay. Multi-broadcaster mix is a v2
question.
