# Tasks — Multiplayer

## US1 — Synced rooms (P1)

- [DONE] T101 Room registry + 6-char codes (no 0/O/1/I/L).
- [DONE] T102 `POST /rooms` + `/join` + `/leave`.
- [DONE] T103 Highway WS with JSON control plane.
- [DONE] T104 NTP-style clock sync + drift correction.
- [DONE] T105 Heartbeats + automatic host promotion.
- [DONE] T106 60-s ephemeral cleanup with rejoin cancellation.

## US2 — Shared queue (P1)

- [DONE] T201 Queue routes (`POST/GET/DELETE`).
- [DONE] T202 Vote-to-skip with majority.
- [DONE] T203 Auto-advance on song end.

## US3 — Per-player arrangements (P2)

- [DONE] T301 Each player picks own arrangement; UI re-renders
  locally only.

## US4 — Recording + mixdown (P2)

- [DONE] T401 `getUserMedia` recording (web).
- [DONE] T402 JUCE recording (desktop).
- [DONE] T403 Per-track upload at stop.
- [DONE] T404 Mini-DAW mixer UI.
- [DONE] T405 FFmpeg mixdown route → MP3 download.

## US5 — Peer audio broadcast (P2, Phase 2d)

- [DONE] T501 Audio WS endpoint (`/ws/.../audio`).
- [DONE] T502 SMAU 40-byte header validation.
- [DONE] T503 Frame size cap (256 KB → 1009).
- [DONE] T504 Per-listener bounded queue (8 frames).
- [DONE] T505 Session FSM (4401 / 4408 / 4409 / 4410).
- [DONE] T506 Broadcast control plane (`broadcast_start /
  broadcast_stop / broadcaster_changed / broadcaster_busy /
  audio_quality`).
- [DONE] T507 v1 param validation (Opus / 48 kHz / mono /
  16-256 kbps).
- [DONE] T508 Single-broadcaster invariant + preemption.
- [DONE] T509 Listener pipeline (WebCodecs decoder + scheduled
  `AudioBufferSourceNode`).
- [DONE] T510 Broadcast capture pipeline (worklet + WebCodecs
  encoder + SMAU build).
- [DONE] T511 Late-join: read `broadcaster_id` from `connected`
  snapshot.
- [DONE] T512 Pause / hard-seek / 4408 grace recovery teardown.
- [DONE] T513 `broadcast_stop` on `beforeunload`.
- [OPEN] T514 [P] **Phase 2e polish** (per PROTOCOL.md: pause/seek
  interaction, tempo-change handling, error states). Tracked in
  PROTOCOL.md §"Status (as of Phase 2d)".

## US6 — Cross-platform (P3)

- [DONE] T601 Web + desktop in same room.
- [DONE] T602 webm-opus → WAV conversion on web upload.

## Cross-cutting

- [DONE] T701 PROTOCOL.md normative spec.
- [DONE] T702 TESTING.md manual matrix.
- [DONE] T703 Backend pytest suite (3 files).
- [DONE] T704 Frontend node:test suite (audio helpers).
- [OPEN] T705 [P] Tempo-change time-stretching (currently the
  `tempo_change_at_end` flag is set but listeners do not act on
  it; v1 lets the one mismatched measure pass through).
- [OPEN] T706 [P] Speed-other-than-1.0× peer audio.
- [OPEN] T707 [P] Multi-broadcaster mix (v2).
- [OPEN] T708 [P] Persistent rooms (would require a DB layer).
- [OPEN] T709 [P] Public room directory + invite links.
- [OPEN] T710 [P] E2E encryption.

## Tests to add

- [OPEN] T801 [P] Test the per-listener purge-timeout behaviour
  (one slow listener doesn't gate `broadcast_start`).
- [OPEN] T802 [P] Test tempo-change banner / `tempo_change_at_end`
  flag wire format.
- [OPEN] T803 [P] Long-running soak in CI (currently manual in
  TESTING.md).
