# Analysis — Multiplayer

## Coverage

| Spec area | Implementation | Notes |
|---|---|---|
| FR-001 (room codes) | `_gen_code` | OK; collision-safe up to 100 retries. |
| FR-002 (player_id) | `_gen_player_id` (`secrets.token_hex(8)`) | OK. |
| FR-003 (session_id syntax) | `_SESSION_ID_RE` | OK. |
| FR-004 (one session per `(room, player_id)`) | `room["sessions"]` | OK; per-room scope avoids global map. |
| FR-005 (4410 single-slot replace) | session FSM | OK; `tests/test_session_lifecycle.py`. |
| FR-006 (4409 takeover) | session FSM | OK; tested. |
| FR-007 (4408 grace expiry) | per-endpoint grace timer | OK; tested. |
| FR-008 (SMAU header validate) | audio frame parse | OK; `tests/test_audio_ws.py`. |
| FR-009 (relay-only) | audio fanout | OK. |
| FR-010 (broadcast_start params) | v1 validation block | OK; `tests/test_broadcast_control.py`. |
| FR-011 (single broadcaster) | broadcaster preemption | OK; tested. |
| FR-012 (8-frame queue) | `_AUDIO_SEND_QUEUE_MAX` | OK. |
| FR-013 (purge timeout) | `_PURGE_TIMEOUT_SEC` | OK; not directly tested (T801). |
| FR-014 (host promotion / creator grace) | host promotion logic | OK. |
| FR-015 (room cleanup 60 s) | `_cleanup_tasks` | OK. |
| FR-016 / FR-017 (record + mixdown) | recordings route + FFmpeg | OK. |
| FR-018 (listener scheduling) | `screen.js` listener pipeline | OK; documented in PROTOCOL.md "Status as of Phase 2d". |
| FR-019 (tempo-change banner) | broadcaster UI banner + flag | OK; banner present, flag set; **listener does not yet act on it** (T705). |
| FR-020 (capture pipeline) | broadcast capture | OK. |

## Drift

1. **Phase 2e (polish)** is in flight per PROTOCOL.md but not
   exhaustively tracked. Items reasonably called out in the doc:
   pause/seek interaction edge cases, tempo-change listener-side
   handling, error-state UI.
2. **`tempo_change_at_end`** is set on the wire but **not consumed**
   on the listener side. The one-measure mismatch documented in the
   README is still a live behaviour. Either (a) implement
   time-stretching, (b) document that listeners ignore the flag.
3. **`audio/*.js` source files have unit tests, but the inlined
   copies in `screen.js` could drift.** A guard is implied (the
   README and screen.js both call out that audio modules are
   inlined because the loader serves only `screen.js`), but no CI
   rule enforces "inlined = source-of-truth byte-equal."
4. **`screen.js` is 5,107 lines.** Reasonable for the feature
   surface, but the lack of formal section boundaries makes audits
   hard. Consider sentinel comments at major section boundaries
   (already partially present).
5. **Speed-other-than-1.0× peer audio** is documented as a v1
   limitation, but the listener pipeline rejects with a
   `listener_speed` counter — confirm this is observable to the
   user (is there a UI indication, or only telemetry?).
6. **`audio_quality` control message exists** but its semantics are
   only briefly documented in PROTOCOL.md. Consider expanding the
   wire-format section.

## Gaps

1. T801 — no automated test that one slow listener doesn't gate
   `broadcast_start`. The 0.5 s purge cap is critical to UX
   under partial-failure conditions.
2. T802 — tempo-change wire test missing.
3. T803 — no soak test in CI; soak is manual in TESTING.md.
4. **Inlining drift** — if `audio/smau-frame.js` is updated but the
   inlined copy in `screen.js` isn't, the unit tests pass but
   production breaks. Either (a) add a CI script that
   `diff`s the source-of-truth file against the inlined region, or
   (b) generate the inlined region from the source file at
   release time.
5. **Audio bitrate is fixed at 96 kbps** in the broadcaster (see
   FR-020 description). The validated range allows 16-256 kbps;
   exposing bitrate in the UI would let users on tight uplinks
   downscale.
6. **Listener telemetry** (`listener_paused`, `listener_speed`,
   `listener_late`, `listener_dropped`) is reported in 30-second
   rolling deltas — is there server-side logging / aggregation, or
   only the broadcaster's panel readout?

## Recommendations

1. **Close out Phase 2e** with explicit tests for pause-during-
   broadcast, mid-stream tempo change, and the listener teardown
   path on `4408` grace recovery. T514.
2. **Pick a tempo-change strategy** (time-stretch or document
   one-measure tolerance) and either implement or annotate. T705.
3. **Add an inlined-modules drift guard** — see Gap 4. Cheap to
   implement (`grep -A` of the inlined block + diff against the
   source file).
4. **Expose bitrate in broadcaster UI** for users on constrained
   uplinks. Validation already covers 16-256 kbps.
5. **Document `audio_quality` semantics** in PROTOCOL.md.
6. **Add T801 / T802 / T803** so the lifecycle / tempo / soak
   coverage is automated.
