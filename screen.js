// Multiplayer plugin — synced rooms, shared queue, optional mixdown

(function () {
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let _ws = null;
let _roomCode = null;
let _playerId = null;
let _sessionId = null;
let _playerName = '';
let _isHost = false;
let _room = null;

// Clock sync
let _clockOffset = 0;       // local_time - server_time in ms
let _pendingSyncResolve = null;

// Playback sync
let _heartbeatInterval = null;
let _driftResetTimer = null;
let _songLoading = false;

// Recording
let _mediaStream = null;
let _mediaRecorder = null;
let _recordedChunks = [];
let _isRecording = false;
let _recStartServerTime = 0;  // server time (ms) when recording started

// Reconnection
let _reconnectAttempts = 0;
let _reconnectTimer = null;
let _intentionalClose = false;

// Audio WebSocket (Phase 2a — connection lifecycle only; the listener +
// broadcast pipelines that actually consume / produce audio frames land
// in Phase 2b). The audio WS runs in parallel to the highway WS, sharing
// the same session_id, with its own independent reconnect timer because
// PROTOCOL.md "Per-endpoint grace" treats the two endpoints' liveness
// independently.
let _audioWs = null;
let _audioReconnectAttempts = 0;
let _audioReconnectTimer = null;

// Tracks (filename, arrangement) of the chart most recently loaded via
// _loadSong. Used by _bootstrapOnConnected to avoid a redundant reload
// on transient WS reconnects when the local <audio> already has the
// right song AND arrangement: _loadSong sets _songLoading = true for
// ~2s, and both _onHeartbeat and _audioListenerHandleFrame drop work
// during that window. Both fields must match — switching arrangement
// (Lead ↔ Rhythm ↔ Bass) calls a different playSong() variant, so a
// filename-only cache would skip a needed reload after a mid-room
// arrangement change. Reset in _cleanup.
let _loadedFilename = null;
let _loadedArrangement = null;
// Promise of an in-flight _loadSong, or null. _bootstrapOnConnected
// checks this so a second _loadSong call (e.g. a reconnect arriving
// mid-song-change) doesn't overlap the first — _loadSong's tail
// pauses non-host audio, and a stale tail firing after the bootstrap
// has resumed playback would leave the guest stuck stopped.
let _loadingPromise = null;
// Generation counter bumped in _cleanup. _doLoadSong captures it at
// entry and refuses to persist _loadedFilename / _loadedArrangement
// if the value has changed — without this, a song load that started
// in room A could finish after the user joined room B and poison
// the cache (a later bootstrap into room B would then skip a needed
// reload thinking room A's song was already loaded).
let _loadGen = 0;

// Idempotency guard for _onSessionEnded: when a 4408 (grace expired) close
// fires, BOTH endpoint handlers see it. Resetting session_id twice would
// produce two different new ids, and the two reconnects would then collide
// (one would arrive as session A, the other as session B → server treats
// it as a Rule 3 takeover loop). _resetMarker remembers the new id we just
// minted; the second handler sees _sessionId == _resetMarker and skips.
//
// _resetMarker stays armed until BOTH endpoints have committed to the
// new session_id (highway received its `connected` message AND audio's
// onopen fired). Clearing on the first endpoint's commit alone reopens
// the race: a late 4408 from the still-stale OTHER endpoint would see
// _resetMarker == null and mint a SECOND fresh session_id, invalidating
// the recovery.
let _resetMarker = null;
let _highwayAuthedAfterReset = true;  // initially true — no reset has happened
let _audioOpenedAfterReset = true;

// Original functions (saved for restore on leave)
let _origTogglePlay = null;
let _origSeekBy = null;
let _origSetSpeed = null;

const STORAGE_KEY = 'slopsmith_mp';
const SESSION_STORAGE_KEY = 'mp_session';
const SYNC_ROUNDS = 5;
const HEARTBEAT_HZ = 100;  // ms between heartbeats

// Close codes from PROTOCOL.md "Endpoints" / "v1 server policy".
const CLOSE_GRACE_EXPIRED = 4408;
const CLOSE_SUPERSEDED = 4409;
const CLOSE_REPLACED = 4410;

// ── SMAU audio frame codec (inlined) ─────────────────────────────────────────
//
// Source of truth: audio/smau-frame.js (CommonJS, exercised by
// audio/smau-frame.test.js — `node audio/smau-frame.test.js`). Inlined here
// because slopsmith core's plugin loader only serves the single screen.js
// entry point per plugin (see plugins/__init__.py). When changing this
// codec, change BOTH copies and re-run the Node tests.
//
// Wire format defined by PROTOCOL.md "Audio frame format (Audio WS)":
// 40-byte little-endian header + Opus payload, validated against v1 hard
// constants (NOT peer-supplied broadcast_start params) so a malicious
// broadcaster cannot enlarge the bounds.
const SMAU_HEADER_LEN = 40;
const SMAU_VERSION = 1;
const SMAU_MAX_FRAME_BYTES = 262144;   // 256 KB
const SMAU_V1_SAMPLE_RATE = 48000;
const SMAU_V1_CHANNEL_COUNT = 1;
const SMAU_MAX_INTERVAL_SEC = 32;
const SMAU_MAX_SLACK_SAMPLES = 480;    // ~10 ms at 48 kHz
const SMAU_FLAG_TEMPO_CHANGE_AT_END = 0x0001;
const SMAU_MAGIC_0 = 0x53; // 'S'
const SMAU_MAGIC_1 = 0x4d; // 'M'
const SMAU_MAGIC_2 = 0x41; // 'A'
const SMAU_MAGIC_3 = 0x55; // 'U'

function _smauDecodeFrame(buf) {
    let bytes;
    if (buf instanceof Uint8Array) {
        bytes = buf;
    } else if (buf instanceof ArrayBuffer) {
        bytes = new Uint8Array(buf);
    } else if (buf && ArrayBuffer.isView(buf)) {
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
        return { ok: false, reason: 'invalid_buffer' };
    }
    const len = bytes.byteLength;
    if (len < SMAU_HEADER_LEN) return { ok: false, reason: 'too_small' };
    if (len > SMAU_MAX_FRAME_BYTES) return { ok: false, reason: 'frame_too_big' };
    if (bytes[0] !== SMAU_MAGIC_0 || bytes[1] !== SMAU_MAGIC_1
        || bytes[2] !== SMAU_MAGIC_2 || bytes[3] !== SMAU_MAGIC_3) {
        return { ok: false, reason: 'magic_mismatch' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, len);
    const version = view.getUint16(4, true);
    if (version !== SMAU_VERSION) return { ok: false, reason: 'version_mismatch' };
    const flags = view.getUint16(6, true);
    const intervalIndex = view.getBigUint64(8, true);
    const chartTimeStart = view.getFloat64(16, true);
    const chartTimeEnd = view.getFloat64(24, true);
    const sampleCount = view.getUint32(32, true);
    const opusSize = view.getUint32(36, true);
    if (SMAU_HEADER_LEN + opusSize !== len) return { ok: false, reason: 'size_mismatch' };
    if (!Number.isFinite(chartTimeStart) || !Number.isFinite(chartTimeEnd)) {
        return { ok: false, reason: 'invalid_chart_time' };
    }
    const duration = chartTimeEnd - chartTimeStart;
    if (!Number.isFinite(duration) || duration <= 0 || duration > SMAU_MAX_INTERVAL_SEC) {
        return { ok: false, reason: 'invalid_duration' };
    }
    const maxSamples = Math.ceil(SMAU_V1_SAMPLE_RATE * duration) + SMAU_MAX_SLACK_SAMPLES;
    if (sampleCount > maxSamples) return { ok: false, reason: 'sample_count_too_high' };

    const opus = new Uint8Array(bytes.buffer, bytes.byteOffset + SMAU_HEADER_LEN, opusSize);
    return {
        ok: true,
        header: {
            version: version,
            flags: flags,
            intervalIndex: intervalIndex,
            chartTimeStart: chartTimeStart,
            chartTimeEnd: chartTimeEnd,
            sampleCount: sampleCount,
            opusSize: opusSize,
            frameLength: len,
            tempoChangeAtEnd: (flags & SMAU_FLAG_TEMPO_CHANGE_AT_END) !== 0,
        },
        opus: opus,
    };
}

// Per-session inbound-frame counters. Cleared in _cleanup. The Phase 5
// listener-side `audio_quality` highway message will read these so the
// broadcaster can see "N frames dropped due to <reason>" in its UI.
// Exposed on window for debugging via _audioGetRxStats(); not a public API.
let _audioRxFramesValid = 0;
let _audioRxFramesDropped = 0;
let _audioRxFramesLate = 0;        // Phase 2c: incremented in listener pipeline
let _audioRxFramesScheduled = 0;   // Phase 2c: incremented in listener pipeline
const _audioRxDropReasons = Object.create(null);

function _audioRxRecordDrop(reason) {
    _audioRxFramesDropped++;
    _audioRxDropReasons[reason] = (_audioRxDropReasons[reason] || 0) + 1;
}

function _audioRxResetStats() {
    _audioRxFramesValid = 0;
    _audioRxFramesDropped = 0;
    _audioRxFramesLate = 0;
    _audioRxFramesScheduled = 0;
    for (const key of Object.keys(_audioRxDropReasons)) {
        delete _audioRxDropReasons[key];
    }
}

function _audioGetRxStats() {
    return {
        valid: _audioRxFramesValid,
        dropped: _audioRxFramesDropped,
        dropReasons: Object.assign({}, _audioRxDropReasons),
        late: _audioRxFramesLate,
        scheduled: _audioRxFramesScheduled,
    };
}

// ── Listener pipeline (Phase 2c) ─────────────────────────────────────────────
//
// Decode validated SMAU frames via WebCodecs AudioDecoder and schedule
// playback so each interval starts when the listener's chart playback
// reaches `chartTimeStart + intervalDuration` — i.e. one interval AFTER the
// broadcaster recorded it (the structured Ninjam offset). Conversion from
// chart-time → AudioContext.currentTime uses the listener's <audio> element
// as the chart clock: at any given instant `audio.currentTime` is the
// listener's chart playback position and AudioContext.currentTime is the
// monotonic rendering clock. Their delta lets us schedule:
//
//   target_chart    = frame.chartTimeStart + (chartTimeEnd - chartTimeStart)
//   chart_now       = audio.currentTime           // (paused → bail out)
//   delta_sec       = target_chart - chart_now
//   target_ac_time  = audioCtx.currentTime + delta_sec
//
// If delta_sec is negative the frame is late (can't schedule into the past)
// and the frame is dropped with a 'late' counter increment. v1 ALSO bails out
// when the chart is paused or playing at non-1.0 speed: speed changes warp
// chart_now relative to AudioContext.currentTime, so a peer recording made
// at 1.0x would not stay in alignment. Documented limitation; Phase 2d /
// release polish may add `playbackRate` time-stretching on the source node.
//
// Decoder output is correlated to header metadata via the encoded chunk's
// timestamp field. We allocate a monotonic per-pipeline counter rather than
// reuse interval_index because EncodedAudioChunk.timestamp is Number-typed
// (microseconds) and interval_index is u64 / BigInt — Number can't hold it
// without precision loss above 2^53.
//
// WebCodecs AudioDecoder is required. v1 surfaces a one-shot console warning
// when it's missing (notably Firefox <130) and silently drops decode work.

const LATE_FRAME_GRACE_SEC = 0.005; // 5 ms slack for browser rAF jitter

let _audioListenerCtx = null;          // AudioContext, lazy
let _audioListenerBroadcasterId = null;
let _audioListenerBroadcastParams = null;
// _audioListenerActiveDecoder is { dec, pending, nextTs, epoch } or
// null. Each decoder instance owns its own `pending` Map so flush()
// output from a drained-but-not-yet-closed decoder can never collide
// with timestamps issued by a fresh replacement (codex round-N
// concurrency case: leave + rejoin can otherwise reuse timestamps from
// the old decoder's still-pending output and schedule stale audio
// against new metadata).
let _audioListenerActiveDecoder = null;
// Bumped on every chart-time-breaking event (chart pause / seek / song
// change / 4408 recovery / cleanup / new-broadcaster takeover). Each
// decoder wrapper captures the current epoch at creation; output
// handler drops its AudioData if the wrapper's epoch is no longer
// current. This catches the case where a graceful flush() of a
// broadcast_stop'd decoder is still in flight when chart-time gets
// invalidated — without the epoch check, those late outputs would
// schedule stale audio against the new chart timeline.
let _audioListenerEpoch = 0;
// Handoff suppression window. SMAU frames carry no sender identity, so
// when a broadcaster_changed event announces a NEW broadcaster, packets
// that the previous broadcaster's worker had already written to TCP
// can still arrive on /audio after the highway event reaches us. Those
// frames would otherwise be decoded under the new broadcaster_id.
// During the suppression window any inbound /audio frame is dropped
// with reason 'handoff_suppress'. Server-side worker purge is the
// primary defense (cancels in-flight sends + drains queues); this is
// belt-and-suspenders for bytes already in the OS TCP buffer at purge
// time. 200 ms is a tight bound on "TCP-buffered straggler RTT" while
// short enough to NOT clip the first frame from new broadcasters that
// use very short intervals (e.g. interval_beats=1 on fast tempos);
// PROTOCOL.md's selectInterval algorithm only uses 4 / 8 beats so v1
// broadcasters won't hit this in practice, but we keep the window
// tight as a forward-compat safety.
const HANDOFF_SUPPRESS_MS = 200;
let _audioListenerHandoffSuppressUntil = 0;
let _audioListenerGain = null;         // GainNode → destination
const _audioListenerScheduledSources = new Set();
let _audioListenerWebCodecsWarned = false;
// Sticky "this browser cannot decode our Opus stream" flag. Set on the
// first AudioDecoder.configure() failure; subsequent inbound frames take
// the cheap silent-no-op path instead of constructing + closing a fresh
// AudioDecoder per frame (browsers that expose AudioDecoder but lack
// Opus support throw on every configure). Reset only on _cleanup so
// reattaching to a new browser process is the only way to re-test.
let _audioListenerOpusUnsupported = false;

function _audioListenerHasWebCodecs() {
    return typeof AudioDecoder !== 'undefined'
        && typeof EncodedAudioChunk !== 'undefined';
}

function _audioListenerWarnOnceMissingWebCodecs() {
    if (_audioListenerWebCodecsWarned) return;
    _audioListenerWebCodecsWarned = true;
    console.warn('[MP] WebCodecs AudioDecoder unavailable; peer audio playback disabled in this browser.');
}

function _audioListenerEnsureContext() {
    if (_audioListenerCtx) return _audioListenerCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    // sampleRate matches the v1 broadcast format so AudioBuffers from the
    // decoder don't need resampling on insert.
    _audioListenerCtx = new Ctor({ sampleRate: SMAU_V1_SAMPLE_RATE, latencyHint: 'interactive' });
    _audioListenerGain = _audioListenerCtx.createGain();
    _audioListenerGain.gain.value = 1.0;
    _audioListenerGain.connect(_audioListenerCtx.destination);
    // Best-effort resume — Chrome/Firefox in active tabs usually create
    // contexts in 'running' state, but on autoplay-restricted browsers
    // (Safari, sometimes Chrome) the context may be 'suspended' until
    // a user gesture. _audioListenerMaybeResumeContext() retries
    // opportunistically from chart play / broadcast-toggle paths so
    // peer audio comes online as soon as the user interacts. For
    // non-host listeners who never trigger those paths themselves,
    // also install a document-level user-gesture handler that calls
    // resume() the next time the user interacts with the page.
    _audioListenerMaybeResumeContext();
    _audioListenerInstallResumeGesture();
    return _audioListenerCtx;
}

let _audioListenerResumeGestureHandler = null;

function _audioListenerInstallResumeGesture() {
    if (_audioListenerResumeGestureHandler) return;
    _audioListenerResumeGestureHandler = () => _audioListenerMaybeResumeContext();
    // Capture phase + listed gesture types match what browsers
    // recognize as user activation for Web Audio resume(). Idempotent;
    // remains live until _audioListenerCleanup tears it down.
    document.addEventListener('pointerdown', _audioListenerResumeGestureHandler, true);
    document.addEventListener('keydown', _audioListenerResumeGestureHandler, true);
    document.addEventListener('touchstart', _audioListenerResumeGestureHandler, true);
}

function _audioListenerUninstallResumeGesture() {
    if (!_audioListenerResumeGestureHandler) return;
    document.removeEventListener('pointerdown', _audioListenerResumeGestureHandler, true);
    document.removeEventListener('keydown', _audioListenerResumeGestureHandler, true);
    document.removeEventListener('touchstart', _audioListenerResumeGestureHandler, true);
    _audioListenerResumeGestureHandler = null;
}

function _audioListenerMaybeResumeContext() {
    const ctx = _audioListenerCtx;
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    // Suppress unhandled-rejection noise on browsers where resume()
    // requires a user gesture and the current call site isn't one
    // (we'll get another chance on the next chart play).
    try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* */ }
}

function _audioListenerHandleDecodedAudio(audioData, wrapper) {
    try {
        const ctx = _audioListenerCtx;
        if (!ctx) return;
        // AudioContext is suspended (autoplay-restricted browsers,
        // notably Safari/iOS and some Chrome cases without a user
        // gesture). ctx.currentTime is effectively frozen, so any
        // schedule we'd compute would either play out of sync once
        // resume() lands or never become audible. Drop instead;
        // _audioListenerMaybeResumeContext() will pick the context
        // back up on the next user-gesture transport interaction,
        // and subsequent frames will schedule normally.
        if (ctx.state !== 'running') {
            _audioRxRecordDrop('context_suspended');
            return;
        }
        // Epoch gate: if chart-time has been invalidated (chart pause /
        // seek / song change / 4408 / cleanup) since this wrapper was
        // created, its pending metadata refers to a chart timeline
        // that's no longer in effect — drop instead of scheduling stale
        // audio against the new timeline. This is the path that catches
        // late outputs from a still-flushing decoder after broadcast_stop.
        if (wrapper.epoch !== _audioListenerEpoch) return;
        const meta = wrapper.pending.get(audioData.timestamp);
        wrapper.pending.delete(audioData.timestamp);
        if (!meta) return; // stale or torn down

        const numFrames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels || 1;
        if (numFrames <= 0) return;
        // Defense against a malicious or buggy broadcaster: the
        // validator already capped header.sampleCount against
        // ceil(V1_SAMPLE_RATE * duration) + MAX_SLACK_SAMPLES, but
        // the Opus payload itself is opaque and could decode to a
        // much longer frame. Recompute the same bound from the
        // validated chart-time duration and drop oversized output —
        // that way a peer can't make us allocate / play arbitrarily
        // long AudioBuffers or drift across interval boundaries.
        const duration = meta.chartTimeEnd - meta.chartTimeStart;
        const maxFrames = Math.ceil(SMAU_V1_SAMPLE_RATE * duration) + SMAU_MAX_SLACK_SAMPLES;
        if (numFrames > maxFrames) {
            _audioRxRecordDrop('decoded_frame_too_long');
            return;
        }
        // Channel count is also bounded: v1 is mono only and the
        // decoder is configured for numberOfChannels=1, but a
        // misconfigured / patched browser could still produce
        // multi-channel output. Reject anything that doesn't match
        // the v1 invariant.
        if (channels !== SMAU_V1_CHANNEL_COUNT) {
            _audioRxRecordDrop('decoded_channel_mismatch');
            return;
        }

        // copyTo() can throw on unsupported conversion formats / internal
        // decoder quirks. Catch in-place so the exception doesn't bubble
        // out of this output callback as an unhandled error and
        // destabilize the decode pipeline. The outer finally still
        // closes the AudioData. Spotted by Copilot review on PR #7.
        let buffer;
        try {
            buffer = ctx.createBuffer(channels, numFrames, audioData.sampleRate || SMAU_V1_SAMPLE_RATE);
            for (let ch = 0; ch < channels; ch++) {
                const out = buffer.getChannelData(ch);
                audioData.copyTo(out, { planeIndex: ch, format: 'f32-planar' });
            }
        } catch (_err) {
            _audioRxRecordDrop('decoded_copy_failed');
            return;
        }

        const audio = document.getElementById('audio');
        if (!audio || audio.paused) {
            // Listener is paused or has no chart audio yet. Drop the
            // decoded interval — it'd schedule into the past once
            // playback resumes anyway, and the chart pause hook will
            // walk pending sources next.
            _audioRxRecordDrop('listener_paused');
            return;
        }
        // Effective-speed re-check — see _audioListenerHandleFrame for
        // why we use audio.playbackRate with 0.01 tolerance (covers
        // drift correction, rejects user-set non-1x speed).
        const speed = audio.playbackRate || 1.0;
        if (Math.abs(speed - 1.0) > 0.01) {
            // v1 limitation: peer audio assumes both ends at 1.0x.
            _audioRxRecordDrop('listener_speed');
            return;
        }

        const targetChart = meta.chartTimeStart + (meta.chartTimeEnd - meta.chartTimeStart);
        const chartNow = audio.currentTime;
        const deltaSec = targetChart - chartNow;
        if (deltaSec < -LATE_FRAME_GRACE_SEC) {
            _audioRxFramesLate++;
            // Also account in the unified drop-reason map so
            // getAudioRxStats() reports late frames consistently with
            // other drop reasons. Spotted by Copilot review on PR #7.
            _audioRxRecordDrop('late');
            return;
        }

        const startAt = ctx.currentTime + Math.max(0, deltaSec);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(_audioListenerGain);
        source.onended = () => { _audioListenerScheduledSources.delete(source); };
        _audioListenerScheduledSources.add(source);
        try {
            source.start(startAt);
            _audioRxFramesScheduled++;
        } catch (e) {
            _audioListenerScheduledSources.delete(source);
        }
    } finally {
        // AudioData is a transferable owning a chunk of decoder memory; close
        // it on every output to release that backing store.
        try { audioData.close(); } catch (e) { /* */ }
    }
}

function _audioListenerOnDecoderError(err, wrapper) {
    // Decoder errors usually mean the configuration didn't match the
    // stream. Tear the pipeline down so the next inbound frame
    // rebuilds it cleanly — but ONLY if the error came from the
    // currently-live decoder. _audioListenerFlushAndCloseDecoder()
    // leaves an old decoder draining asynchronously while a fresh
    // replacement may already be live; a late error from the drained
    // decoder must not kill the replacement.
    console.error('[MP] AudioDecoder error:', err);
    _audioRxRecordDrop('decoder_error');
    if (_audioListenerActiveDecoder === wrapper) {
        _audioListenerTeardownDecoder();
    }
}

function _audioListenerEnsureDecoder() {
    if (_audioListenerActiveDecoder) return _audioListenerActiveDecoder;
    if (_audioListenerOpusUnsupported) return null;
    if (!_audioListenerHasWebCodecs()) {
        _audioListenerWarnOnceMissingWebCodecs();
        return null;
    }
    // Each decoder instance gets its own per-instance pending map and
    // timestamp counter (see _audioListenerActiveDecoder doc above) so
    // late output from a flushing-but-not-yet-closed prior decoder can
    // never collide with timestamps issued by this new one. The epoch
    // is captured at creation so the output handler can drop late
    // AudioData if chart-time has since been broken.
    const wrapper = { dec: null, pending: new Map(), nextTs: 0, epoch: _audioListenerEpoch };
    let dec = null;
    try {
        dec = new AudioDecoder({
            output: (ad) => _audioListenerHandleDecodedAudio(ad, wrapper),
            // Capture `wrapper` in the closure so a late error from a
            // drained-but-not-yet-closed decoder doesn't tear down
            // a fresh replacement. See _audioListenerOnDecoderError.
            error: (err) => _audioListenerOnDecoderError(err, wrapper),
        });
        // configure() is synchronous and throws NotSupportedError on
        // browsers that expose AudioDecoder but lack Opus decode (e.g.
        // partial WebCodecs implementations). Catch here rather than
        // letting the exception propagate up through every inbound
        // frame; degrade to the same silent-no-op path as the
        // no-WebCodecs branch and remember the failure so we don't
        // re-throw per inbound frame for the rest of the session.
        dec.configure({
            codec: 'opus',
            sampleRate: SMAU_V1_SAMPLE_RATE,
            numberOfChannels: SMAU_V1_CHANNEL_COUNT,
        });
    } catch (err) {
        if (dec) {
            try { dec.close(); } catch (e) { /* */ }
        }
        // Only mark Opus permanently unsupported when the failure is
        // a clear NotSupportedError. Other errors (transient resource
        // limits, InvalidStateError from an unlucky lifecycle race)
        // should be retryable on the next inbound frame — without
        // this distinction, a single transient failure would mute
        // peer audio for the rest of the session. Spotted by Copilot
        // review on PR #7.
        const sticky = err && err.name === 'NotSupportedError';
        if (sticky) {
            _audioListenerOpusUnsupported = true;
        }
        if (!_audioListenerWebCodecsWarned) {
            _audioListenerWebCodecsWarned = true;
            console.warn(
                sticky
                    ? '[MP] AudioDecoder Opus configure failed (NotSupportedError); peer audio playback disabled for this session.'
                    : '[MP] AudioDecoder Opus configure failed transiently; will retry on next frame.',
                err
            );
        }
        return null;
    }
    wrapper.dec = dec;
    _audioListenerActiveDecoder = wrapper;
    return wrapper;
}

function _audioListenerStopAllSources() {
    for (const src of _audioListenerScheduledSources) {
        try { src.onended = null; src.stop(); } catch (e) { /* */ }
        try { src.disconnect(); } catch (e) { /* */ }
    }
    _audioListenerScheduledSources.clear();
}

function _audioListenerTeardownDecoder() {
    // Hard teardown — used when the chart-time mapping is broken
    // (chart pause / seek / cleanup / 4408 recovery / broadcaster
    // takeover) so any pending output would schedule into garbage.
    // Drops in-flight decode work along with the decoder.
    const wrapper = _audioListenerActiveDecoder;
    _audioListenerActiveDecoder = null;
    if (!wrapper) return;
    if (wrapper.dec) {
        try { wrapper.dec.close(); } catch (e) { /* */ }
    }
    wrapper.pending.clear();
}

function _audioListenerFlushAndCloseDecoder() {
    // Graceful drain — used on broadcast_stop / broadcaster_changed-null
    // so the broadcaster's last-emitted intervals (which may still be
    // sitting in the AudioDecoder pipeline) get a chance to schedule
    // before the decoder shuts down. Per-wrapper pending metadata stays
    // alive in the closure for the output handler to consume during
    // flush() and is released when the wrapper is garbage-collected
    // after close().
    const wrapper = _audioListenerActiveDecoder;
    if (!wrapper || !wrapper.dec) return;
    _audioListenerActiveDecoder = null;
    const dec = wrapper.dec;
    Promise.resolve()
        .then(() => dec.flush())
        .catch(() => { /* drain best-effort; close anyway */ })
        .finally(() => {
            try { dec.close(); } catch (e) { /* */ }
            // wrapper.pending and wrapper.nextTs are local to this
            // wrapper and become unreachable once dec is closed; they
            // are NOT touched here. Any new decoder created in the
            // meantime carries its own independent state.
        });
}

function _audioListenerHandleFrame(header, opus) {
    // Pre-decode short-circuit: if the listener can't play this frame
    // anyway (chart paused, mid-song-load, or non-1.0x effective
    // playback rate), drop it before paying for the opus copy +
    // decode + AudioBuffer expansion. The same checks run again
    // post-decode in case state changes mid-decode (paranoia layer;
    // the common case is the cheap path).
    //
    // Speed gate uses audio.playbackRate (the effective speed) rather
    // than _room.speed, since mpSetSpeed() updates audio.playbackRate
    // synchronously while the server-echoed _room.speed lags by one
    // round trip. The 0.01 tolerance is wider than _onHeartbeat()'s
    // ±0.002 drift-correction band (so routine sync nudges pass
    // through) but narrower than any plausible user-set speed
    // (the slider's smallest non-1x detent is well above 1%).
    if (_songLoading) {
        // _loadSong has a ~2 s plugin-setup window where the <audio>
        // element may briefly read as not-paused while the new song's
        // src/duration/state are still settling. Heartbeats already
        // skip this window via _songLoading (see _onHeartbeat); the
        // listener pipeline needs the same guard so frames arriving
        // during a song switch don't get scheduled against the
        // mid-transition chart timeline.
        _audioRxRecordDrop('song_loading');
        return;
    }
    const audio = document.getElementById('audio');
    if (!audio || audio.paused) {
        _audioRxRecordDrop('listener_paused');
        return;
    }
    const speed = audio.playbackRate || 1.0;
    if (Math.abs(speed - 1.0) > 0.01) {
        _audioRxRecordDrop('listener_speed');
        return;
    }
    // Short-circuit if peer-audio decoding is fundamentally unavailable
    // in this browser. Without this, _audioListenerEnsureContext would
    // construct an AudioContext (and install global resume-gesture
    // listeners) even on browsers that can never decode our frames,
    // tripping autoplay-policy warnings and wasting resources. Spotted
    // by Copilot review on PR #7 round 3.
    if (_audioListenerOpusUnsupported || !_audioListenerHasWebCodecs()) {
        _audioListenerWarnOnceMissingWebCodecs();
        _audioRxRecordDrop('webcodecs_unavailable');
        return;
    }
    // Build the listener pipeline lazily on first valid frame so
    // listeners-with-no-active-broadcast aren't holding an AudioContext open
    // (Chrome warns about unused autoplay-blocked contexts; some browsers
    // also rate-limit how many can exist).
    const ctx = _audioListenerEnsureContext();
    if (!ctx) return;
    if (ctx.state !== 'running') {
        // Pre-decode gate. The output handler also drops on suspended
        // context, but by then we've paid for the opus copy + decode.
        // Drop here so a long autoplay-restricted window (no user
        // gesture yet) doesn't burn decoder CPU per inbound frame.
        // Spotted by Copilot review on PR #7.
        _audioRxRecordDrop('context_suspended');
        return;
    }
    const wrapper = _audioListenerEnsureDecoder();
    if (!wrapper) return;

    const ts = wrapper.nextTs++;
    wrapper.pending.set(ts, {
        chartTimeStart: header.chartTimeStart,
        chartTimeEnd: header.chartTimeEnd,
        sampleCount: header.sampleCount,
        intervalIndex: header.intervalIndex,
    });
    try {
        // Copy opus into a fresh ArrayBuffer because EncodedAudioChunk takes
        // ownership of its buffer view; the original Uint8Array aliases the
        // WebSocket message and may be reused. (Also detaches in some
        // implementations once the chunk is queued.)
        const data = new Uint8Array(opus.byteLength);
        data.set(opus);
        const chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: ts,
            data: data,
        });
        wrapper.dec.decode(chunk);
    } catch (e) {
        wrapper.pending.delete(ts);
        _audioRxRecordDrop('decode_call_failed');
    }
}

function _audioListenerOnControlSet(broadcasterId, params) {
    if (!broadcasterId) {
        _audioListenerOnControlClear();
        return;
    }
    if (_audioListenerBroadcasterId === broadcasterId) {
        // Re-announcement of the current broadcaster (e.g. duplicate
        // broadcaster_changed under reconnection); just refresh params.
        _audioListenerBroadcastParams = params || _audioListenerBroadcastParams;
        return;
    }
    // Switching broadcasters — drop everything from the previous pipeline.
    // Bumping the epoch invalidates any still-flushing OLD wrapper from a
    // graceful broadcast_stop that's racing this broadcast_start: without
    // it, the old broadcaster's tail intervals could schedule after the
    // new broadcaster has been announced. The graceful stop→drain path
    // only matters when no new broadcaster takes over, so bumping here
    // doesn't cost the broadcast-tail behavior.
    const prevBroadcasterId = _audioListenerBroadcasterId;
    if (prevBroadcasterId !== null) {
        // True A → B handoff: arm the suppression window so late /audio
        // packets from A (already on the TCP wire when server-side
        // worker purge ran) are rejected at frame entry until it
        // expires. Skipped on null → B (fresh start) and on the
        // late-join `connected` snapshot path, where there is no
        // previous broadcaster's tail to filter out — those would
        // otherwise gap the start of the new broadcast for 500 ms.
        _audioListenerHandoffSuppressUntil = (
            (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
            + HANDOFF_SUPPRESS_MS
        );
    }
    _audioListenerEpoch++;
    _audioListenerStopAllSources();
    _audioListenerTeardownDecoder();
    _audioListenerBroadcasterId = broadcasterId;
    _audioListenerBroadcastParams = params || null;
    // The pipeline (decoder, source nodes) is rebuilt lazily on first
    // valid frame in _audioListenerHandleFrame. AudioContext is reused.
}

function _audioListenerOnSelfBroadcast() {
    // Self-takeover: the local player has just become the broadcaster.
    // Self-broadcasts disable listener playback entirely (we never want
    // to hear our own loopback echo), so any previous broadcaster's
    // tail that would otherwise drain via _audioListenerOnControlClear
    // must be hard-stopped instead. Bumps the epoch + stops scheduled
    // sources + tears down the decoder synchronously.
    //
    // Always bump the epoch unconditionally, even if the visible state
    // (broadcaster_id, activeDecoder, scheduledSources) all look empty:
    // _audioListenerFlushAndCloseDecoder may have moved the decoder
    // out of _audioListenerActiveDecoder while leaving its flush()
    // running asynchronously in a closure. Without the epoch bump,
    // that decoder's late AudioData would pass the wrapper.epoch
    // check and schedule the previous peer's tail on this machine
    // — exactly the leak this helper is meant to prevent.
    _audioListenerEpoch++;
    _audioListenerStopAllSources();
    _audioListenerTeardownDecoder();
    _audioListenerBroadcasterId = null;
    _audioListenerBroadcastParams = null;
}

function _audioListenerOnControlClear() {
    if (_audioListenerBroadcasterId === null) return;
    // PROTOCOL.md "Lifecycle §5 Stop": broadcast end is graceful —
    // flush() the active decoder so any opus packets we already handed
    // off but haven't yet received as AudioData reach the output
    // handler and get scheduled. Sources already on the AudioContext
    // clock self-remove via onended. v1 limitation: late SMAU frames
    // arriving over /audio AFTER 'broadcaster_changed: null' on the
    // highway WS are dropped with reason 'no_broadcaster' (since the
    // two endpoints are unordered relative to each other and we can't
    // safely accept "unannounced" frames without misattributing a new
    // broadcaster's first frames as the previous broadcaster's tail).
    // The most common case — decoder-internal latency from the last
    // already-fed interval — is handled by flush().
    //
    // Arm the handoff suppression window NOW. If a new broadcaster B
    // takes over within HANDOFF_SUPPRESS_MS, control_set will see
    // prevBroadcasterId === null (we just cleared it) and skip arming
    // its own window — but the timer set here is still counting down,
    // so any of A's TCP-buffered tail packets arriving after
    // broadcaster_changed:B are still rejected. Pre-stop suppression
    // covers the broadcaster_changed:null → broadcaster_changed:B
    // sequence that codex flagged as the regressed common case.
    _audioListenerHandoffSuppressUntil = (
        (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
        + HANDOFF_SUPPRESS_MS
    );
    _audioListenerFlushAndCloseDecoder();
    _audioListenerBroadcasterId = null;
    _audioListenerBroadcastParams = null;
}

function _audioListenerOnChartPause() {
    // Listener paused / seeked. Anything already scheduled on the
    // AudioContext clock would now play out of sync with the new chart
    // position; drop it. The active decoder's pending map is cleared
    // along with the decoder via _audioListenerTeardownDecoder — a
    // fresh decoder is built lazily on the next valid frame after
    // chart playback resumes. Bumping the epoch ensures any output
    // from a still-flushing OLD wrapper (from a previous broadcast_stop)
    // also drops, since their captured epoch is now stale.
    _audioListenerEpoch++;
    _audioListenerStopAllSources();
    _audioListenerTeardownDecoder();
}

function _audioListenerCleanup() {
    // Full teardown — the listener is leaving the room. Unlike a normal
    // broadcast stop, we're tearing the AudioContext itself down, so
    // scheduled sources can't drain. Stop them explicitly. Bumping the
    // epoch invalidates any still-flushing OLD wrappers' outputs.
    _audioListenerEpoch++;
    _audioListenerUninstallResumeGesture();
    _audioListenerStopAllSources();
    _audioListenerTeardownDecoder();
    _audioListenerBroadcasterId = null;
    _audioListenerBroadcastParams = null;
    if (_audioListenerGain) {
        try { _audioListenerGain.disconnect(); } catch (e) { /* */ }
        _audioListenerGain = null;
    }
    if (_audioListenerCtx) {
        try { _audioListenerCtx.close(); } catch (e) { /* */ }
        _audioListenerCtx = null;
    }
    // Reset sticky decoder-support state so a future room-join in the
    // same tab can re-test (the user may have updated the browser, or
    // the previous failure may have been a transient resource limit).
    _audioListenerOpusUnsupported = false;
    _audioListenerWebCodecsWarned = false;
    // No global decode-timestamp counter to reset: each decoder wrapper
    // owns its own counter + pending map. Late output from a flushing
    // old wrapper that survives this cleanup will see _audioListenerCtx
    // null and early-return without scheduling.
    _audioListenerHandoffSuppressUntil = 0;
    _audioRxFramesLate = 0;
    _audioRxFramesScheduled = 0;
}

function _mintSessionId() {
    // crypto.randomUUID is widely available; fall back through getRandomValues
    // if available, then to Math.random as last resort. Every reference to
    // `crypto` is gated by `typeof crypto !== 'undefined'` so environments
    // without Web Crypto don't throw a ReferenceError.
    const hasCrypto = typeof crypto !== 'undefined';
    if (hasCrypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (hasCrypto && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function _getOrMintSessionId() {
    let sid = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!sid) {
        sid = _mintSessionId();
        sessionStorage.setItem(SESSION_STORAGE_KEY, sid);
    }
    return sid;
}

function _resetSessionId() {
    _sessionId = _mintSessionId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, _sessionId);
}

function _onSessionEnded() {
    // Idempotent across concurrent handlers — see _resetMarker comment above.
    if (_resetMarker !== null && _resetMarker === _sessionId) {
        return;
    }
    _resetSessionId();
    _resetMarker = _sessionId;
    // Both endpoints must re-confirm BEFORE we'll consider the recovery
    // complete and clear the dedupe marker. See _maybeClearResetMarker.
    _highwayAuthedAfterReset = false;
    _audioOpenedAfterReset = false;
    // Audio RX counters are documented as per-session; the new session_id
    // we just minted is a logically separate session even though no
    // _cleanup() runs on the 4408 grace-recovery path. Reset the counters
    // so getAudioRxStats() doesn't carry the previous session's frames
    // into the replacement session.
    _audioRxResetStats();
    // The listener pipeline is also per-session in the same sense: the
    // server will re-announce broadcaster_id on the new highway WS's
    // `connected` snapshot so we'd rebuild it cleanly anyway, but old
    // scheduled sources would otherwise keep firing against stale
    // chart-time math during the brief reconnect window. We additionally
    // need to clear _audioListenerBroadcasterId itself: if the audio WS
    // reattaches BEFORE the highway `connected` snapshot arrives,
    // inbound frames would otherwise be accepted and scheduled against
    // stale control-plane state (the broadcast may have stopped, or the
    // broadcaster may have changed, while we were disconnected).
    // Stop sources hard rather than draining — the chart-time mapping
    // is broken until the new `connected` arrives. Bump the epoch so
    // any still-flushing OLD wrapper from a prior broadcast_stop also
    // invalidates (matches the chart-time-breaking pattern in
    // _audioListenerOnChartPause / _audioListenerCleanup).
    _audioListenerEpoch++;
    _audioListenerStopAllSources();
    _audioListenerTeardownDecoder();
    _audioListenerBroadcasterId = null;
    _audioListenerBroadcastParams = null;
    // Don't carry handoff suppression across a session reset — a fresh
    // session from broadcaster B's first frames would otherwise be
    // dropped under handoff_suppress for the remainder of the window
    // even though they belong to a new logical session.
    _audioListenerHandoffSuppressUntil = 0;
}

function _maybeClearResetMarker() {
    if (_highwayAuthedAfterReset && _audioOpenedAfterReset) {
        _resetMarker = null;
    }
}

// ── Lobby ──────────────────────────────────────────────────────────────

function _loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        _playerName = s.name || '';
        const nameCreate = document.getElementById('mp-create-name');
        const nameJoin = document.getElementById('mp-join-name');
        if (nameCreate) nameCreate.value = _playerName;
        if (nameJoin) nameJoin.value = _playerName;
    } catch (e) { /* ignore */ }
}

function _saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        name: _playerName,
    }));
}

let _lobbyErrorTimer = null;
function _showError(msg) {
    const el = document.getElementById('mp-lobby-error');
    if (el) {
        // Cancel any pending hide-timer from a prior error so the new message
        // gets a fresh 5-second window (otherwise an older error's timer can
        // hide a new message early — e.g. a takeover notice arriving moments
        // after a failed join attempt).
        if (_lobbyErrorTimer !== null) clearTimeout(_lobbyErrorTimer);
        el.textContent = msg;
        el.classList.remove('hidden');
        _lobbyErrorTimer = setTimeout(() => {
            el.classList.add('hidden');
            _lobbyErrorTimer = null;
        }, 5000);
    }
}

window.mpCreateRoom = async function () {
    const nameInput = document.getElementById('mp-create-name');
    const name = (nameInput?.value || '').trim();
    if (!name) { _showError('Enter your name'); return; }
    _playerName = name;
    _saveSettings();

    try {
        const resp = await fetch('/api/plugins/multiplayer/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        if (data.error) { _showError(data.error); return; }

        _roomCode = data.code;
        _playerId = data.player_id;
        _isHost = true;
        // Fresh join: always start with a new session_id so we can't accidentally
        // collide with a stale session left over from a previous tab.
        _resetSessionId();
        _resetMarker = null;  // fresh session — clear the 4408 dedupe marker
        sessionStorage.setItem('mp_room', _roomCode);
        sessionStorage.setItem('mp_player', _playerId);
        _connectWS();
        _connectAudioWs();
        _showRoomView();
    } catch (e) {
        _showError('Failed to create room');
    }
};

window.mpJoinRoom = async function () {
    const nameInput = document.getElementById('mp-join-name');
    const codeInput = document.getElementById('mp-join-code');
    const name = (nameInput?.value || '').trim();
    const code = (codeInput?.value || '').trim().toUpperCase();
    if (!name) { _showError('Enter your name'); return; }
    if (!code || code.length < 4) { _showError('Enter a valid room code'); return; }
    _playerName = name;
    _saveSettings();

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${code}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        if (data.error) { _showError(data.error); return; }

        _roomCode = data.code;
        _playerId = data.player_id;
        _isHost = false;
        _room = data.room;
        _resetSessionId();
        _resetMarker = null;
        sessionStorage.setItem('mp_room', _roomCode);
        sessionStorage.setItem('mp_player', _playerId);
        _connectWS();
        _connectAudioWs();
        _showRoomView();
    } catch (e) {
        _showError('Failed to join room');
    }
};

window.mpLeaveRoom = async function () {
    if (!_roomCode || !_playerId) return;
    _intentionalClose = true;

    try {
        await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_id: _playerId }),
        });
    } catch (e) { /* ignore */ }

    _cleanup();
    _showLobbyView();
};

function _cleanup() {
    _stopRecording();
    _stopHeartbeat();
    _restorePlaybackControls();
    _audioListenerCleanup();
    // Set _intentionalClose BEFORE closing either socket so neither close
    // handler triggers a reconnect during teardown.
    _intentionalClose = true;
    if (_ws) {
        try { _ws.close(); } catch (e) { /* ignore */ }
        _ws = null;
    }
    if (_audioWs) {
        try { _audioWs.close(); } catch (e) { /* ignore */ }
        _audioWs = null;
    }
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_audioReconnectTimer) {
        clearTimeout(_audioReconnectTimer);
        _audioReconnectTimer = null;
    }
    _roomCode = null;
    _playerId = null;
    _sessionId = null;
    _isHost = false;
    _room = null;
    _reconnectAttempts = 0;
    _audioReconnectAttempts = 0;
    _resetMarker = null;
    _highwayAuthedAfterReset = true;
    _audioOpenedAfterReset = true;
    _audioRxResetStats();
    _loadedFilename = null;
    _loadedArrangement = null;
    _loadingPromise = null;
    // Invalidate any in-flight bootstrap / song load so its post-await
    // continuations can't apply state to (or cache song markers for)
    // a NEW room the user has just joined. Each helper captures these
    // generation counters at entry and bails / aborts persisting if
    // the captured value is stale.
    _bootstrapGen++;
    _loadGen++;
    sessionStorage.removeItem('mp_room');
    sessionStorage.removeItem('mp_player');
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

// ── Views ──────────────────────────────────────────────────────────────

function _showLobbyView() {
    const lobby = document.getElementById('mp-lobby-view');
    const room = document.getElementById('mp-room-view');
    const mixer = document.getElementById('mp-mixer-view');
    // If the mixer was open and previewing, stop the preview before hiding it —
    // otherwise AudioBufferSourceNodes keep playing with no UI to stop them.
    // _mixerStop is a no-op if no preview is active. Wrapped in a try guard so
    // that early lobby renders (before the mixer module is wired up) can't
    // throw and leave the lobby unrendered.
    if (mixer && !mixer.classList.contains('hidden')) {
        try { _mixerStop(); } catch (e) { /* ignore */ }
    }
    if (lobby) lobby.classList.remove('hidden');
    if (room) room.classList.add('hidden');
    if (mixer) mixer.classList.add('hidden');
}

function _showRoomView() {
    const lobby = document.getElementById('mp-lobby-view');
    const room = document.getElementById('mp-room-view');
    if (lobby) lobby.classList.add('hidden');
    if (room) room.classList.remove('hidden');

    const codeEl = document.getElementById('mp-room-code');
    if (codeEl) codeEl.textContent = _roomCode || '';

    _renderPlayers();
    _renderQueue();
    _updateControls();
}

// ── WebSocket ──────────────────────────────────────────────────────────

function _connectWS() {
    // Stale-out the old socket BEFORE closing it. If onclose fires synchronously
    // (or before we reassign _ws below), the early-return `if (ws !== _ws)` in
    // the close handler catches it and avoids touching state for a connection
    // we're intentionally replacing.
    if (_ws) {
        const old = _ws;
        _ws = null;
        try { old.close(); } catch (e) { /* */ }
    }
    _intentionalClose = false;
    if (!_sessionId) _sessionId = _getOrMintSessionId();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/plugins/multiplayer/${_roomCode}`
        + `?player_id=${encodeURIComponent(_playerId)}`
        + `&session_id=${encodeURIComponent(_sessionId)}`;
    const ws = new WebSocket(url);
    _ws = ws;

    const statusEl = document.getElementById('mp-connection-status');

    ws.onopen = () => {
        _reconnectAttempts = 0;
        if (statusEl) statusEl.textContent = 'Connected';
        // Clock sync starts when we receive 'connected' message
    };

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            _handleMessage(msg);
        } catch (e) {
            console.error('[MP] Bad message:', e);
        }
    };

    ws.onclose = (ev) => {
        // If a newer connection has already replaced _ws, this is the OLD socket
        // closing — don't touch global state or trigger reconnect.
        if (ws !== _ws) return;
        _stopHeartbeat();

        if (ev && ev.code === CLOSE_REPLACED) {
            // Same-session reconnect performed by us elsewhere; new socket has
            // already taken over (or is about to). Nothing to do here.
            if (statusEl) statusEl.textContent = 'Connection replaced';
            return;
        }
        if (ev && ev.code === CLOSE_SUPERSEDED) {
            // Different tab took over the session. Per PROTOCOL.md, we MUST NOT
            // auto-reconnect (would just steal back). Run the full cleanup path
            // (clears _room, _isHost, _roomCode/_playerId/_sessionId, restores
            // playback controls, removes sessionStorage keys) and bounce back to
            // the lobby so the UI doesn't keep showing the room view, host
            // controls, OR mixer view for a session this tab no longer owns.
            _cleanup();
            _showLobbyView();
            // Surface the takeover notice via the lobby-visible error element;
            // #mp-connection-status lives inside the now-hidden room view.
            _showError('Session moved to another tab');
            return;
        }
        if (ev && ev.code === CLOSE_GRACE_EXPIRED) {
            // Grace expired without reattach. The held session is dead; mint a
            // fresh session_id (idempotently — _onSessionEnded handles the
            // race with the audio WS handler that also sees 4408) and let
            // the reconnect path open a new one.
            _onSessionEnded();
            if (statusEl) statusEl.textContent = 'Reconnecting…';
            if (!_intentionalClose && _roomCode) {
                _scheduleReconnect();
                _scheduleAudioReconnect();
            }
            return;
        }

        if (statusEl) statusEl.textContent = 'Disconnected';
        if (!_intentionalClose && _roomCode) {
            _scheduleReconnect();
        }
    };

    ws.onerror = () => {
        if (statusEl) statusEl.textContent = 'Connection error';
    };
}

function _scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), 30000);
    const statusEl = document.getElementById('mp-connection-status');
    if (statusEl) statusEl.textContent = `Reconnecting in ${Math.round(delay / 1000)}s...`;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (_roomCode && _playerId) {
            _connectWS();
        }
    }, delay);
}

// ── Audio WS (Phase 2a) ───────────────────────────────────────────────────
//
// Lifecycle parallels _connectWS / _scheduleReconnect on the highway side.
// Per PROTOCOL.md "Per-endpoint grace", the audio WS has its own grace
// window and reconnect cadence independent of the highway. Phase 2a wires
// the connection lifecycle only — frame send / receive land in Phase 2b.

function _connectAudioWs() {
    // Stale-out the old socket BEFORE closing it so a synchronous onclose
    // for the OLD ws hits the early-return `if (ws !== _audioWs)` and
    // doesn't try to reconnect / mutate state we're intentionally
    // replacing. (Same pattern as _connectWS.)
    if (_audioWs) {
        const old = _audioWs;
        _audioWs = null;
        try { old.close(); } catch (e) { /* */ }
    }
    if (!_roomCode || !_playerId) return;
    if (!_sessionId) _sessionId = _getOrMintSessionId();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/plugins/multiplayer/${_roomCode}/audio`
        + `?player_id=${encodeURIComponent(_playerId)}`
        + `&session_id=${encodeURIComponent(_sessionId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    _audioWs = ws;

    ws.onopen = () => {
        // PROTOCOL.md "Implementation note (client side)": open is NOT proof
        // of auth on the audio WS. Don't surface "ready" UI here — the
        // user-visible "audio is live" signal lives in the highway WS
        // control plane (broadcaster_changed) and the first inbound frame.
        _audioReconnectAttempts = 0;
        // Audio side of a session-recovery has reattached. _maybeClearResetMarker
        // only clears the dedupe marker once the highway side has ALSO
        // reattached. See _resetMarker comment.
        _audioOpenedAfterReset = true;
        _maybeClearResetMarker();
    };

    ws.onmessage = (ev) => {
        // Stale-socket guard. _connectAudioWs() replaces the live socket
        // on reconnect / 4408 recovery / leave; in-flight frames already
        // queued on the old socket can still arrive between our
        // assignment of the new _audioWs and the OS-level close
        // handshake completing. Without this check those frames would
        // be parsed and counted against the current session — see
        // codex-flagged drift in getAudioRxStats(). Mirrors the same
        // pattern in onclose.
        if (ws !== _audioWs) return;
        // PROTOCOL.md "Audio WS — binary peer-audio relay" makes the audio
        // WS binary-only in v1. Drop any text frame outright — text frames
        // are spec-illegal and may indicate a server bug or middlebox
        // injection; counted under the dedicated 'non_binary' reason so
        // it's visible if it ever happens.
        if (typeof ev.data === 'string') {
            _audioRxRecordDrop('non_binary');
            return;
        }
        // Parse + validate the 40-byte SMAU header (Phase 2b) and route
        // valid frames into the WebCodecs decode + scheduled-playback
        // pipeline (Phase 2c). Frames whose broadcaster_id doesn't match
        // the control-plane's announced broadcaster are also dropped here
        // — the server's single-broadcaster gate normally catches this
        // but the receiver double-checks since fan-out is byte-for-byte
        // and the wire format does not name the broadcaster (broadcaster
        // identity comes from the highway WS).
        const result = _smauDecodeFrame(ev.data);
        if (!result.ok) {
            _audioRxRecordDrop(result.reason);
            return;
        }
        if (!_audioListenerBroadcasterId) {
            // No active broadcaster announced (or it's the local player).
            // Drop pre-announce / post-tear-down frames so they don't get
            // scheduled with stale chart-time metadata. v1 limitation
            // (codex multi-round): we deliberately do NOT keep a drain
            // grace window here because the highway WS and /audio WS
            // are unordered — accepting frames during a drain window
            // can misattribute a new broadcaster's first frame as the
            // previous broadcaster's tail. The flushAndClose path
            // already drains decoder-internal pending opus, which
            // handles the common case where the decoder has unflushed
            // work for an already-fed-but-not-yet-output interval.
            _audioRxRecordDrop('no_broadcaster');
            return;
        }
        if (_audioListenerHandoffSuppressUntil > 0) {
            // Handoff window guard: bytes already in flight from the
            // previous broadcaster's audio worker can arrive after we
            // process broadcaster_changed for the new broadcaster.
            // Reject during the window so they don't get decoded
            // against the new broadcaster's chart-time metadata.
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
            if (now < _audioListenerHandoffSuppressUntil) {
                _audioRxRecordDrop('handoff_suppress');
                return;
            }
            _audioListenerHandoffSuppressUntil = 0;
        }
        _audioRxFramesValid++;
        _audioListenerHandleFrame(result.header, result.opus);
    };

    ws.onclose = (ev) => {
        if (ws !== _audioWs) return;

        if (ev && ev.code === CLOSE_REPLACED) {
            // Same-session reconnect of the audio slot — a new audio ws has
            // already taken over. Nothing to do here.
            return;
        }
        if (ev && ev.code === CLOSE_SUPERSEDED) {
            // Different tab took over the whole session. Normally the
            // highway-side 4409 handler runs the lobby bounce — the server
            // closes both endpoints simultaneously, and the highway path
            // gets there first. But the spec explicitly allows audio-only
            // sessions during per-endpoint grace, so this audio close may
            // be the ONLY 4409 we see. If the highway socket is already
            // gone (or never attached), run the cleanup ourselves;
            // otherwise leave it to the highway handler.
            const highwayDead = (
                _ws === null
                || _ws.readyState === WebSocket.CLOSING
                || _ws.readyState === WebSocket.CLOSED
            );
            if (highwayDead) {
                _cleanup();
                _showLobbyView();
                _showError('Session moved to another tab');
            }
            return;
        }
        if (ev && ev.code === CLOSE_GRACE_EXPIRED) {
            // Grace expired. Reset session_id idempotently (the highway
            // 4408 handler may have already done it) and reconnect both
            // endpoints under the new session_id.
            _onSessionEnded();
            if (!_intentionalClose && _roomCode) {
                _scheduleReconnect();
                _scheduleAudioReconnect();
            }
            return;
        }
        // 4401 (auth fail), 1009 (frame too big), 1011 (server error), or
        // a transient drop. For 4401 we don't auto-reconnect — the highway
        // side rejection is the primary signal and will handle UI cleanup.
        // For 1009 we also don't auto-reconnect (we sent a bad frame). For
        // everything else (including 1006 abnormal close), reconnect.
        if (ev && (ev.code === 4401 || ev.code === 1009)) return;
        if (!_intentionalClose && _roomCode) _scheduleAudioReconnect();
    };

    ws.onerror = () => {
        // Errors that aren't followed by a close event are rare; the close
        // handler does the recovery work. Don't duplicate it here.
    };
}

function _scheduleAudioReconnect() {
    if (_audioReconnectTimer) return;
    _audioReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _audioReconnectAttempts - 1), 30000);
    _audioReconnectTimer = setTimeout(() => {
        _audioReconnectTimer = null;
        if (_roomCode && _playerId) {
            _connectAudioWs();
        }
    }, delay);
}

// ── Connected-snapshot recovery ────────────────────────────────────────
//
// Brings the local <audio> element + listener pipeline online after a
// fresh join or reconnect, given the room snapshot in `_room`. Sequenced
// so peer-audio scheduling can latch onto a freshly synced chart clock
// without ever observing an unloaded / mid-pause audio element:
//
//   1. _loadSong  — guarantees the <audio> element has a src loaded.
//                   Runs for hosts and guests; both can be listening
//                   to another player's broadcast (host case: the
//                   server suppresses self-echo of playback_state, so
//                   the snapshot is the host's only chance to realign).
//   2. Apply room.time/speed/state — _loadSong pauses non-host audio
//                                    on completion, so the play() must
//                                    run AFTER it. Significant chart
//                                    time jumps fire _audioListenerOnChartPause
//                                    to invalidate any in-flight
//                                    schedule from before the reconnect.
//   3. Activate listener pipeline — broadcaster_id from snapshot
//                                   selects control_set / self / clear.
//
// _bootstrapGen guards against stale completions: another `connected`
// snapshot or `song_changed` can arrive during _loadSong's ~2 s async
// setup window. Each call captures its own generation; after every
// await, it bails out if the generation no longer matches (a newer
// bootstrap has superseded it). Without this, the OLD load can finish
// and apply chart-time / listener state for a song that's no longer
// the room's current song.

let _bootstrapGen = 0;

async function _bootstrapOnConnected() {
    if (!_room) return;
    const myGen = ++_bootstrapGen;
    // Hard-teardown the listener pipeline ONLY if the snapshot
    // represents a meaningful state change (different broadcaster,
    // different song, or different arrangement). A bare highway
    // reconnect that re-issues the same `connected` snapshot
    // shouldn't interrupt peer audio — its scheduled sources are
    // still anchored to the right chart timeline, and tearing them
    // down here would cause an audible dropout for what is otherwise
    // a transparent control-plane blip. The state-apply step below
    // will still re-seek if local audio.currentTime has drifted
    // (which calls _audioListenerOnChartPause itself), so we don't
    // miss legitimate chart-time invalidations.
    const sameBroadcaster = _audioListenerBroadcasterId === (_room.broadcaster_id || null);
    const wantedFilename = (
        typeof _room.now_playing === 'number'
        && _room.now_playing >= 0
        && _room.queue
        && _room.queue[_room.now_playing]
    ) ? _room.queue[_room.now_playing].filename : null;
    const wantedArrangement = (_room.players && _room.players[_playerId])
        ? _room.players[_playerId].arrangement : 'Lead';
    const sameSong = wantedFilename === _loadedFilename && wantedArrangement === _loadedArrangement;
    if (!sameBroadcaster || !sameSong) {
        // If we previously had a broadcaster and now the snapshot
        // shows a different one (or none), the audio WS may still
        // hold buffered packets from the previous broadcaster that
        // arrive after the snapshot. Arm the handoff suppression
        // window now — clearing _audioListenerBroadcasterId before
        // _audioListenerOnControlSet runs at the bottom of bootstrap
        // would otherwise make that call see a null→new transition
        // and skip its own suppression arming.
        if (
            _audioListenerBroadcasterId !== null
            && _audioListenerBroadcasterId !== (_room.broadcaster_id || null)
        ) {
            _audioListenerHandoffSuppressUntil = (
                (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
                + HANDOFF_SUPPRESS_MS
            );
        }
        _audioListenerOnChartPause();
        _audioListenerBroadcasterId = null;
        _audioListenerBroadcastParams = null;
    }
    if (
        typeof _room.now_playing === 'number'
        && _room.now_playing >= 0
        && _room.queue
        && _room.queue[_room.now_playing]
    ) {
        const wantedItem = _room.queue[_room.now_playing];
        const wantedArr = (_room.players && _room.players[_playerId])
            ? _room.players[_playerId].arrangement : 'Lead';
        // Skip the reload if the local <audio> element already has
        // the right track + arrangement loaded — _loadSong sets
        // _songLoading = true for ~2 s and both _onHeartbeat and
        // _audioListenerHandleFrame drop work during that window, so a
        // transient WS reconnect would otherwise needlessly mute peer
        // audio + heartbeat corrections. A reload is only needed when
        // the snapshot's current song or this player's arrangement
        // differs from what we last loaded.
        if (
            wantedItem.filename !== _loadedFilename
            || wantedArr !== _loadedArrangement
        ) {
            let loadFailed = false;
            try {
                await _loadSong(wantedItem);
            } catch (e) {
                // Fail closed: don't apply chart state or activate the
                // listener pipeline against whatever stale <audio>
                // source was previously loaded. The listener will
                // continue dropping inbound frames as 'listener_paused'
                // (or 'no_broadcaster', since broadcaster_id is still
                // null — we cleared it at the top) until the user
                // intervenes (reload, manual song pick).
                loadFailed = true;
            }
            // A newer connected snapshot or song_changed may have superseded
            // this bootstrap during the ~2 s _loadSong window. If so, the
            // newer call has already done (or will do) its own load + state
            // apply — DON'T touch chart state here against stale _room
            // values that may still be sitting in scope.
            if (myGen !== _bootstrapGen) return;
            if (loadFailed) return;
        }
    }
    // Snapshot may have changed during the await (a 4408 / leave can
    // null _room). Recheck before touching audio state.
    if (!_room) return;
    if (typeof _room.time === 'number') {
        const audioEl = document.getElementById('audio');
        if (audioEl) {
            // Detect whether the snapshot actually requires a state
            // change to the local <audio>. If everything matches
            // (transient highway reconnect with no real change),
            // skip the chartPause so peer-audio scheduling continues
            // uninterrupted.
            const drift = Math.abs((audioEl.currentTime || 0) - _room.time);
            const wantedSpeed = _room.speed || 1.0;
            const speedDelta = Math.abs((audioEl.playbackRate || 1.0) - wantedSpeed);
            const wantPaused = _room.state === 'paused' || _room.state === 'stopped';
            const wantPlaying = _room.state === 'playing';
            const stateChange = (
                drift > 0.05
                || speedDelta > 0.01
                || (wantPlaying && audioEl.paused)
                || (wantPaused && !audioEl.paused)
            );
            if (stateChange) {
                // Snapshot-driven state restore is a chart-time-breaking
                // event from the listener pipeline's perspective: any
                // sources scheduled before the reconnect were anchored
                // against the PRE-reconnect chart timeline / speed /
                // play-pause state. Drop them; new frames will rebuild
                // a fresh schedule against the synced clock.
                _audioListenerOnChartPause();
                // 0.05s threshold (vs the prior 0.5s): _onHeartbeat's
                // normal drift correction nudges playbackRate by only
                // ±0.002, which would take many seconds to close a
                // 50–500 ms post-reconnect drift.
                if (drift > 0.05) {
                    try { audioEl.currentTime = _room.time; } catch (e) { /* */ }
                }
                if (speedDelta > 0.01) {
                    audioEl.playbackRate = wantedSpeed;
                }
                if (wantPlaying && audioEl.paused) {
                    _audioListenerMaybeResumeContext();
                    audioEl.play().catch(() => {});
                } else if (wantPaused && !audioEl.paused) {
                    // Both 'paused' (user-pressed pause) and 'stopped'
                    // (no song loaded / queue finished) imply the
                    // chart clock should not be running locally.
                    try { audioEl.pause(); } catch (e) { /* */ }
                }
            }
        }
    }
    // Activate the listener pipeline LAST, against the now-synced
    // chart clock. Doing this earlier would let frames arriving
    // during _loadSong / state-apply schedule against the stale
    // pre-reconnect chart timeline.
    if (_room.broadcaster_id && _room.broadcaster_id !== _playerId) {
        _audioListenerOnControlSet(_room.broadcaster_id, _room.broadcast_params || null);
    } else if (_room.broadcaster_id === _playerId) {
        _audioListenerOnSelfBroadcast();
    } else {
        _audioListenerOnControlClear();
    }
}

// ── Message Handling ───────────────────────────────────────────────────

function _handleMessage(msg) {
    switch (msg.type) {
        case 'connected':
            _room = msg.room;
            _isHost = _room.host === _playerId;
            _renderPlayers();
            _renderQueue();
            _updateControls();
            _doClockSync();
            // The recovery flow (load song, sync chart clock, resume
            // playback, activate listener) is async because _loadSong
            // pauses non-host audio when it completes. Running play()
            // before _loadSong finishes would briefly play and then be
            // re-paused by the load. Defer to a fire-and-forget helper
            // that awaits the load before applying state and listener
            // setup.
            _bootstrapOnConnected().catch(() => {});
            // Highway side of the recovery is confirmed. _maybeClearResetMarker
            // only clears the dedupe marker once the audio side has ALSO
            // reattached — see _resetMarker comment for the race this guards.
            _highwayAuthedAfterReset = true;
            _maybeClearResetMarker();
            break;

        case 'clock_sync_response':
            if (_pendingSyncResolve) {
                _pendingSyncResolve(msg);
                _pendingSyncResolve = null;
            }
            break;

        case 'player_joined':
            if (_room) {
                _room.players[msg.player_id] = {
                    name: msg.name,
                    arrangement: msg.arrangement || 'Lead',
                    connected: false,
                };
                _renderPlayers();
            }
            break;

        case 'player_left':
            if (_room) {
                delete _room.players[msg.player_id];
                _renderPlayers();
            }
            break;

        case 'player_connected':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].connected = true;
                _renderPlayers();
            }
            break;

        case 'player_disconnected':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].connected = false;
                _renderPlayers();
            }
            break;

        case 'host_changed':
            if (_room) {
                _room.host = msg.new_host_id;
                _isHost = _room.host === _playerId;
                if (_isHost) _startHeartbeat();
                else _stopHeartbeat();
                _renderPlayers();
                _updateControls();
            }
            break;

        case 'arrangement_changed':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].arrangement = msg.arrangement;
                _renderPlayers();
            }
            break;

        case 'playback_state':
            if (!_isHost) _onPlaybackState(msg);
            if (_room) {
                _room.state = msg.state;
                _room.time = msg.time;
                _room.speed = msg.speed;
            }
            break;

        case 'heartbeat':
            if (!_isHost) _onHeartbeat(msg);
            break;

        case 'queue_updated':
            if (_room) {
                _room.queue = msg.queue;
                _room.now_playing = msg.now_playing;
                _renderQueue();
            }
            break;

        case 'song_changed':
            if (_room) {
                _room.now_playing = msg.now_playing;
                _room.state = 'stopped';
                _room.time = 0;
                _renderQueue();
                _updateNowPlaying();
                // Chart timeline just changed under any in-flight peer-audio
                // schedule. Drop it so already-queued sources don't keep
                // playing on top of the new song; a `playback_state` update
                // will start the new schedule once the new song is loaded.
                _audioListenerOnChartPause();
                // Invalidate any in-flight _bootstrapOnConnected so its
                // mid-await loadSong-of-the-old-song doesn't proceed to
                // apply state for the wrong track.
                _bootstrapGen++;
                // Host already called _loadSong in mpLoadSong — skip to avoid double-load
                if (!_isHost && msg.queue_item) _loadSong(msg.queue_item);
            }
            break;

        case 'queue_finished':
            if (_room) {
                _room.now_playing = -1;
                _room.state = 'stopped';
                _renderQueue();
                _updateNowPlaying();
                // Chart timeline ended. Same reasoning as song_changed.
                _audioListenerOnChartPause();
                _bootstrapGen++;
            }
            break;

        case 'vote_skip':
            _updateSkipCount(msg.votes, msg.needed);
            break;

        case 'recording_state':
            if (_room) _room.recording = msg.recording;
            _onRecordingState(msg.recording);
            break;

        case 'recording_uploaded':
            if (_room) {
                if (!_room.recordings_received) _room.recordings_received = [];
                if (msg.player_id && !_room.recordings_received.includes(msg.player_id)) {
                    _room.recordings_received.push(msg.player_id);
                }
            }
            _updateRecordingStatus(msg);
            break;

        case 'mixdown_ready':
            _onMixdownReady(msg.url);
            break;

        case 'room_destroyed':
            _cleanup();
            _showLobbyView();
            _showError('Room was closed');
            break;

        case 'broadcaster_changed':
            // PROTOCOL.md "Audio control messages — broadcast_start" /
            // "broadcast_stop": single source of truth for who (if anyone)
            // is broadcasting in this room. Mirror the room state so a
            // subsequent reconnect's `connected` snapshot stays in sync,
            // and route to the listener pipeline. v1: hosts don't listen
            // to themselves — the broadcaster_id check skips self-loop.
            if (_room) {
                _room.broadcaster_id = msg.broadcaster_id || null;
                _room.broadcast_params = msg.broadcaster_id ? {
                    interval_beats: msg.interval_beats,
                    sample_rate: msg.sample_rate,
                    channel_count: msg.channel_count,
                    codec: msg.codec,
                    bitrate: msg.bitrate,
                } : null;
            }
            if (msg.broadcaster_id && msg.broadcaster_id !== _playerId) {
                _audioListenerOnControlSet(msg.broadcaster_id, _room ? _room.broadcast_params : null);
            } else if (msg.broadcaster_id === _playerId) {
                // Self-takeover: hard-stop instead of graceful drain;
                // see _audioListenerOnSelfBroadcast for why we don't
                // want to keep playing the previous broadcaster's tail
                // on the new broadcaster's machine.
                _audioListenerOnSelfBroadcast();
            } else {
                _audioListenerOnControlClear();
            }
            break;

        case 'error':
            console.error('[MP] Server error:', msg.message);
            break;
    }
}

// ── Clock Sync ─────────────────────────────────────────────────────────

async function _doClockSync() {
    const rounds = [];

    for (let i = 0; i < SYNC_ROUNDS; i++) {
        const t1 = performance.now();
        _ws.send(JSON.stringify({ type: 'clock_sync_request', client_t1: t1 }));

        const result = await new Promise((resolve) => {
            _pendingSyncResolve = resolve;
            setTimeout(() => {
                if (_pendingSyncResolve === resolve) {
                    _pendingSyncResolve = null;
                    resolve(null);
                }
            }, 2000);
        });

        if (result) {
            const t4 = performance.now();
            const rtt = (t4 - result.client_t1) - (result.server_t3 - result.server_t2);
            const offset = ((result.server_t2 - result.client_t1) + (result.server_t3 - t4)) / 2;
            rounds.push({ rtt, offset });
        }

        await new Promise(r => setTimeout(r, 50));
    }

    if (rounds.length >= 3) {
        rounds.sort((a, b) => a.rtt - b.rtt);
        const mid = Math.floor(rounds.length / 2);
        _clockOffset = rounds[mid].offset;
    }

    console.log(`[MP] Clock sync: offset=${_clockOffset.toFixed(1)}ms (${rounds.length} rounds)`);

    // If host, start heartbeat
    if (_isHost) _startHeartbeat();

    // Intercept playback controls
    _interceptPlaybackControls();
}

// ── Playback Sync ──────────────────────────────────────────────────────

function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatInterval = setInterval(() => {
        if (!_ws || _ws.readyState !== WebSocket.OPEN || !_isHost) return;
        const audio = document.getElementById('audio');
        if (!audio || audio.paused) return;
        _ws.send(JSON.stringify({
            type: 'heartbeat',
            time: audio.currentTime,
            client_time: performance.now(),
        }));
    }, HEARTBEAT_HZ);
}

function _stopHeartbeat() {
    if (_heartbeatInterval) {
        clearInterval(_heartbeatInterval);
        _heartbeatInterval = null;
    }
}

function _onPlaybackState(msg) {
    const audio = document.getElementById('audio');
    if (!audio) return;

    if (msg.state === 'playing') {
        // Any in-flight peer-audio scheduling was anchored against the
        // PREVIOUS chart position; a hard seek invalidates it. Drop the
        // schedule and let new frames rebuild it organically.
        _audioListenerOnChartPause();
        // The same play→audio.play() call site is the user-gesture
        // window where a previously-suspended listener AudioContext
        // can resume. Best-effort; no-op if the context is already
        // running or doesn't yet exist.
        _audioListenerMaybeResumeContext();
        audio.currentTime = msg.time;
        audio.playbackRate = msg.speed || 1.0;
        audio.play().catch(() => {});
        if (typeof isPlaying !== 'undefined') isPlaying = true;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '\u23F8 Pause';
        const mpBtn = document.getElementById('mp-btn-play');
        if (mpBtn) mpBtn.textContent = 'Pause';
        _startRecordingNow();
    } else if (msg.state === 'paused') {
        // Listener paused — schedule must be cleared, future frames will
        // be dropped with reason 'listener_paused' until play resumes.
        _audioListenerOnChartPause();
        audio.currentTime = msg.time;
        audio.pause();
        if (typeof isPlaying !== 'undefined') isPlaying = false;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '\u25B6 Play';
        const mpBtn = document.getElementById('mp-btn-play');
        if (mpBtn) mpBtn.textContent = 'Play';
    }

    // Update speed UI
    const speedLabel = document.getElementById('mp-speed-label');
    const speedSlider = document.getElementById('mp-speed');
    if (speedLabel) speedLabel.textContent = (msg.speed || 1.0).toFixed(2) + 'x';
    if (speedSlider) speedSlider.value = Math.round((msg.speed || 1.0) * 100);
}

function _onHeartbeat(msg) {
    if (_isHost || _songLoading) return;
    const audio = document.getElementById('audio');
    if (!audio || audio.paused) return;

    const drift = audio.currentTime - msg.time;
    const absDrift = Math.abs(drift);

    if (absDrift > 0.5) {
        // Hard seek — drop scheduled peer audio so it doesn't play out of
        // sync with the new chart position.
        _audioListenerOnChartPause();
        audio.currentTime = msg.time;
        if (typeof highway !== 'undefined') highway.setTime(msg.time);
    } else if (absDrift > 0.05) {
        // Micro-adjust: if ahead slow down, if behind speed up
        const baseSpeed = (_room && _room.speed) || 1.0;
        const correction = drift > 0 ? -0.002 : 0.002;
        audio.playbackRate = baseSpeed + correction;

        if (_driftResetTimer) clearTimeout(_driftResetTimer);
        _driftResetTimer = setTimeout(() => {
            audio.playbackRate = baseSpeed;
            _driftResetTimer = null;
        }, 500);
    }
}

// ── Playback Interception ──────────────────────────────────────────────

function _injectPlayerRecBtn() {
    const c = document.getElementById('player-controls');
    if (!c || document.getElementById('mp-player-rec-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'mp-player-rec-btn';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    btn.textContent = 'REC';
    btn.title = _isHost ? 'Toggle recording' : 'Recording controlled by host';
    btn.disabled = !_isHost;
    btn.style.opacity = _isHost ? '' : '0.5';
    btn.onclick = () => {
        if (!_isHost || !_ws) return;
        const isRec = _room && _room.recording;
        _ws.send(JSON.stringify({ type: isRec ? 'stop_recording' : 'start_recording' }));
    };
    // Update appearance based on current state
    if (_room && _room.recording) {
        btn.className = 'px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 rounded-lg text-xs text-red-400 transition';
        btn.textContent = '⏺ REC';
    }
    const separator = c.querySelector('span.text-gray-700');
    if (separator) c.insertBefore(btn, separator);
    else c.appendChild(btn);
}

function _removePlayerRecBtn() {
    const btn = document.getElementById('mp-player-rec-btn');
    if (btn) btn.remove();
}

function _updatePlayerRecBtn(recording) {
    const btn = document.getElementById('mp-player-rec-btn');
    if (!btn) return;
    if (recording) {
        btn.className = 'px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 rounded-lg text-xs text-red-400 transition';
        btn.textContent = '⏺ REC';
    } else {
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        btn.textContent = 'REC';
    }
}

function _interceptPlaybackControls() {
    if (_origTogglePlay) return; // already intercepted
    _injectPlayerRecBtn();
    _origTogglePlay = window.togglePlay;
    _origSeekBy = window.seekBy;
    _origSetSpeed = window.setSpeed;

    window.togglePlay = function () {
        if (_roomCode) {
            if (_isHost) {
                mpTogglePlay();
            }
            // Non-host: no-op
        } else if (_origTogglePlay) {
            _origTogglePlay();
        }
    };

    window.seekBy = function (s) {
        if (_roomCode) {
            if (_isHost) mpSeek(s);
        } else if (_origSeekBy) {
            _origSeekBy(s);
        }
    };

    window.setSpeed = function (v) {
        if (_roomCode) {
            if (_isHost) mpSetSpeed(v);
        } else if (_origSetSpeed) {
            _origSetSpeed(v);
        }
    };
}

function _restorePlaybackControls() {
    if (_origTogglePlay) { window.togglePlay = _origTogglePlay; _origTogglePlay = null; }
    if (_origSeekBy) { window.seekBy = _origSeekBy; _origSeekBy = null; }
    if (_origSetSpeed) { window.setSpeed = _origSetSpeed; _origSetSpeed = null; }
    _removePlayerRecBtn();
}

// ── Host Playback Controls ─────────────────────────────────────────────

function mpTogglePlay() {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;

    if (audio.paused) {
        // Mirror non-host transport hooks: a host listening to another
        // player's broadcast also has scheduled peer audio anchored to
        // the chart timeline, and the host's own play/pause never goes
        // through _onPlaybackState.
        _audioListenerOnChartPause();
        // Invalidate any in-flight _bootstrapOnConnected so its mid-
        // await tail can't re-pause/re-seek us back to the stale
        // pre-transport snapshot state after we've just acted.
        _bootstrapGen++;
        _audioListenerMaybeResumeContext();
        audio.play().catch(() => {});
        if (typeof isPlaying !== 'undefined') isPlaying = true;
        _ws.send(JSON.stringify({
            type: 'play',
            time: audio.currentTime,
            speed: audio.playbackRate,
        }));
        const btn = document.getElementById('mp-btn-play');
        if (btn) btn.textContent = 'Pause';
        const mainBtn = document.getElementById('btn-play');
        if (mainBtn) mainBtn.textContent = '\u23F8 Pause';
        _startRecordingNow();
    } else {
        _audioListenerOnChartPause();
        _bootstrapGen++;
        audio.pause();
        if (typeof isPlaying !== 'undefined') isPlaying = false;
        _ws.send(JSON.stringify({
            type: 'pause',
            time: audio.currentTime,
        }));
        const btn = document.getElementById('mp-btn-play');
        if (btn) btn.textContent = 'Play';
        const mainBtn = document.getElementById('btn-play');
        if (mainBtn) mainBtn.textContent = '\u25B6 Play';
    }
}
window.mpTogglePlay = mpTogglePlay;

function mpSeek(delta) {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;
    // Hard seek invalidates any peer-audio schedule that was anchored
    // against the previous chart position. Also bump _bootstrapGen so
    // an in-flight reconnect bootstrap can't re-seek us back to its
    // stale snapshot time after this action.
    _audioListenerOnChartPause();
    _bootstrapGen++;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
    _ws.send(JSON.stringify({
        type: 'seek',
        time: audio.currentTime,
    }));
}
window.mpSeek = mpSeek;

function mpSetSpeed(val) {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;
    const speed = parseFloat(val) / 100;
    // Any speed change invalidates the peer-audio schedule. We don't
    // time-stretch in v1, so a non-1.0x setting silences peer audio
    // (frames dropped via the listener_speed gate). But returning TO
    // 1.0x also has to flush: sources scheduled at the old non-1.0
    // chart→AudioContext mapping would otherwise still fire after the
    // reset. Non-host listeners don't have this gap because their
    // _onPlaybackState path clears on every echoed set_speed; mirror
    // that here for the host's local schedule. Also bump
    // _bootstrapGen so an in-flight reconnect bootstrap can't re-set
    // playbackRate to its stale snapshot value after this action.
    _audioListenerOnChartPause();
    _bootstrapGen++;
    audio.playbackRate = speed;
    _ws.send(JSON.stringify({
        type: 'set_speed',
        speed: speed,
    }));
    const label = document.getElementById('mp-speed-label');
    if (label) label.textContent = speed.toFixed(2) + 'x';
}
window.mpSetSpeed = mpSetSpeed;

// ── Song Loading ───────────────────────────────────────────────────────

async function _loadSong(queueItem) {
    // Deduplicate concurrent loads. _loadSong has a tail that pauses
    // non-host audio, so two overlapping invocations can step on each
    // other: the second's bootstrap resumes playback and then the
    // first's pause runs after, leaving the guest stuck stopped.
    // Concurrent calls share the same in-flight promise so callers
    // see a single completion.
    //
    // Loop because two callers waiting on the SAME _loadingPromise
    // both fall through after it resolves; if the awaited load didn't
    // produce the file we want, we'd otherwise both kick a new
    // _doLoadSong (overlapping again). The loop re-checks
    // _loadingPromise after each wait — the first waiter to fall
    // through claims the next slot; subsequent waiters await its
    // promise instead of starting a fresh one.
    while (_loadingPromise) {
        const inflight = _loadingPromise;
        await inflight.catch(() => {});
        // If the in-flight load already loaded the requested file +
        // arrangement, don't restart. Reload if either the filename
        // OR the player's selected arrangement has changed.
        const wantedArr = (_room && _room.players && _room.players[_playerId])
            ? _room.players[_playerId].arrangement : 'Lead';
        if (queueItem
            && _loadedFilename === queueItem.filename
            && _loadedArrangement === wantedArr) {
            return;
        }
        // Another caller may have already chained the next load while
        // we were awaiting — if so, await theirs instead of starting
        // a fresh overlapping one.
        if (_loadingPromise && _loadingPromise !== inflight) continue;
        break;
    }
    const myPromise = _doLoadSong(queueItem);
    _loadingPromise = myPromise;
    try {
        await myPromise;
    } finally {
        // Only clear the slot if it still points at OUR promise. A
        // newer caller waiting on us above may have already chained
        // its own _doLoadSong into _loadingPromise during the await
        // (the chain pattern in the loop). Clobbering would let yet
        // another caller think no load is active and start a third
        // overlapping _doLoadSong, which is the exact race this
        // helper exists to prevent.
        if (_loadingPromise === myPromise) {
            _loadingPromise = null;
        }
    }
}

async function _doLoadSong(queueItem) {
    const myLoadGen = _loadGen;
    _songLoading = true;
    // Find arrangement index matching this player's chosen arrangement
    const myArrangement = (_room && _room.players[_playerId])
        ? _room.players[_playerId].arrangement : 'Lead';
    let arrIndex;
    const arrs = queueItem.arrangements || [];
    const idx = arrs.findIndex(a =>
        (typeof a === 'string' ? a : a.name) === myArrangement
    );
    if (idx >= 0) arrIndex = idx;

    let succeeded = false;
    try {
        // Call global playSong (await to let the full plugin chain set up).
        // If playSong isn't installed (slopsmith core not loaded yet, or
        // some unexpected page state), treat as a load failure so we
        // don't poison the cache by marking a never-loaded song as
        // ready. Spotted by Copilot review on PR #7 round 3.
        if (typeof playSong !== 'function') {
            return;
        }
        await playSong(queueItem.filename, arrIndex);
        // Give plugins time to finish async setup (stems, highway _onReady, etc.)
        await new Promise(r => setTimeout(r, 2000));
        succeeded = true;
    } finally {
        // Always clear _songLoading so heartbeats and the listener
        // pipeline stop dropping under 'song_loading' even if playSong
        // or the plugin chain throws — otherwise a single failed load
        // would gate them for the rest of the session.
        _songLoading = false;
        // Only persist the cache markers on a SUCCESSFUL load that's
        // still authoritative. Two reasons:
        //   1. If the load throws, _bootstrapOnConnected uses the
        //      markers as proof of readiness; we want a retry on the
        //      next reconnect.
        //   2. _cleanup() bumps _loadGen to invalidate stale loads —
        //      a load that started in room A and completed after the
        //      user joined room B would otherwise mark room A's song
        //      as "already loaded", making a subsequent bootstrap
        //      skip a needed reload.
        if (succeeded && _loadGen === myLoadGen) {
            _loadedFilename = queueItem ? queueItem.filename : null;
            _loadedArrangement = myArrangement;
        }
    }

    if (!_isHost) {
        const audio = document.getElementById('audio');
        if (audio) {
            audio.pause();
            if (typeof isPlaying !== 'undefined') isPlaying = false;
        }
    }
}

// Host loads and starts a song from the queue
window.mpLoadSong = function (index) {
    if (!_isHost || !_ws) return;
    _ws.send(JSON.stringify({ type: 'load_song', index: index }));
    // Also load locally
    if (_room && _room.queue[index]) {
        _room.now_playing = index;
        _room.state = 'stopped';
        _room.time = 0;
        _renderQueue();
        _updateNowPlaying();
        // Chart timeline is about to change — drop any peer-audio
        // schedule anchored against the old chart. The server emits
        // song_changed with exclude=this player, so the inbound
        // dispatch's song_changed branch never fires for the host;
        // mirror its _audioListenerOnChartPause() call here so a
        // host listening to another player's broadcast doesn't keep
        // hearing the previous chart's peer audio over the new song.
        // Also bump _bootstrapGen so an in-flight reconnect bootstrap
        // (which can be mid-_loadSong of the OLD now_playing for ~2 s)
        // doesn't run its post-await tail against the now-stale
        // snapshot, e.g. by re-pause/seek/listener-set against the
        // previous song.
        _audioListenerOnChartPause();
        _bootstrapGen++;
        _loadSong(_room.queue[index]);
    }
};

// ── Queue UI ───────────────────────────────────────────────────────────

window.mpSearchSongs = async function () {
    const q = document.getElementById('mp-search')?.value.trim();
    if (!q) return;
    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=artist`);
    const data = await resp.json();
    const container = document.getElementById('mp-search-results');
    if (!container) return;

    if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No results</p>';
        return;
    }

    container.innerHTML = data.songs.map(s => {
        const arrs = (s.arrangements || []).map(a => a.name || a);
        const arrsJson = JSON.stringify(arrs).replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition">
            <div class="flex-1 min-w-0">
                <span class="text-sm text-white">${esc(s.title)}</span>
                <span class="text-xs text-gray-500 ml-2">${esc(s.artist)}</span>
            </div>
            <button onclick="mpAddToQueue('${encodeURIComponent(s.filename)}','${esc(s.title).replace(/'/g,"\\'")}','${esc(s.artist).replace(/'/g,"\\'")}', '${arrsJson}')"
                class="px-3 py-1 bg-dark-600 hover:bg-accent/30 rounded text-xs text-gray-300 hover:text-white transition flex-shrink-0">+ Add</button>
        </div>`;
    }).join('');
};

window.mpAddToQueue = async function (filename, title, artist, arrsJson) {
    if (!_roomCode || !_playerId) return;
    let arrangements = [];
    try { arrangements = JSON.parse(arrsJson.replace(/&quot;/g, '"')); } catch (e) { /* */ }
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            player_id: _playerId,
            filename: decodeURIComponent(filename),
            title, artist, arrangements,
        }),
    });
};

window.mpRemoveFromQueue = async function (index) {
    if (!_roomCode) return;
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/queue/${index}?player_id=${_playerId}`, {
        method: 'DELETE',
    });
};

window.mpVoteSkip = async function () {
    if (!_roomCode || !_playerId) return;
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/vote-skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: _playerId }),
    });
};

function _renderQueue() {
    if (!_room) return;
    const container = document.getElementById('mp-queue-list');
    const countEl = document.getElementById('mp-queue-count');
    if (!container) return;

    if (countEl) countEl.textContent = _room.queue.length ? `${_room.queue.length} song${_room.queue.length !== 1 ? 's' : ''}` : '';

    if (_room.queue.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">No songs in queue.</p>';
        _updateNowPlaying();
        return;
    }

    container.innerHTML = _room.queue.map((item, i) => {
        const isCurrent = i === _room.now_playing;
        const addedBy = _findPlayerName(item.added_by);
        return `<div class="flex items-center gap-3 ${isCurrent ? 'bg-accent/10 border-accent/30' : 'bg-dark-700/30 border-gray-800/30'} border rounded-lg p-3 transition">
            <span class="text-xs ${isCurrent ? 'text-accent' : 'text-gray-600'} w-6 text-center font-mono">${isCurrent ? '\u25B6' : i + 1}</span>
            <div class="flex-1 min-w-0 ${_isHost && i !== _room.now_playing ? 'cursor-pointer' : ''}"
                 ${_isHost && i !== _room.now_playing ? `onclick="mpLoadSong(${i})"` : ''}>
                <span class="text-sm text-white truncate block">${esc(item.title || item.filename)}</span>
                <span class="text-xs text-gray-500">${esc(item.artist || '')}${addedBy ? ' \u00B7 added by ' + esc(addedBy) : ''}</span>
            </div>
            <button onclick="mpRemoveFromQueue(${i})"
                class="px-2 py-1 text-gray-600 hover:text-red-400 transition text-xs flex-shrink-0">\u2715</button>
        </div>`;
    }).join('');

    _updateNowPlaying();
}

function _updateNowPlaying() {
    const infoEl = document.getElementById('mp-now-playing-info');
    if (!infoEl || !_room) return;

    if (_room.now_playing >= 0 && _room.now_playing < _room.queue.length) {
        const item = _room.queue[_room.now_playing];
        infoEl.innerHTML = `
            <div class="text-white font-semibold">${esc(item.title || item.filename)}</div>
            <div class="text-xs text-gray-500 mt-0.5">${esc(item.artist || '')}</div>
        `;
    } else {
        infoEl.textContent = 'No song loaded. Add songs to the queue below.';
    }
}

function _updateSkipCount(votes, needed) {
    const el1 = document.getElementById('mp-skip-count');
    const el2 = document.getElementById('mp-skip-count-guest');
    const text = `(${votes}/${needed})`;
    if (el1) el1.textContent = text;
    if (el2) el2.textContent = text;
}

function _findPlayerName(playerId) {
    if (!_room || !playerId) return '';
    const p = _room.players[playerId];
    return p ? p.name : '';
}

// ── Player List ────────────────────────────────────────────────────────

function _renderPlayers() {
    const container = document.getElementById('mp-player-list');
    if (!container || !_room) return;

    const pids = Object.keys(_room.players);
    container.innerHTML = pids.map(pid => {
        const p = _room.players[pid];
        const isMe = pid === _playerId;
        const isPlayerHost = pid === _room.host;
        return `<div class="flex items-center gap-3 bg-dark-800/50 rounded-lg p-3 ${isMe ? 'ring-1 ring-accent/30' : ''}">
            <div class="w-2 h-2 rounded-full flex-shrink-0 ${p.connected ? 'bg-green-400' : 'bg-gray-600'}"></div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-white truncate">${esc(p.name)}</span>
                    ${isPlayerHost ? '<span class="text-[10px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded">Host</span>' : ''}
                    ${isMe ? '<span class="text-[10px] bg-accent/20 text-accent-light px-1.5 py-0.5 rounded">You</span>' : ''}
                </div>
            </div>
            ${isMe
                ? `<select onchange="mpSetArrangement(this.value)"
                    class="bg-dark-700 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-accent/50">
                    <option value="Lead" ${p.arrangement === 'Lead' ? 'selected' : ''}>Lead</option>
                    <option value="Rhythm" ${p.arrangement === 'Rhythm' ? 'selected' : ''}>Rhythm</option>
                    <option value="Bass" ${p.arrangement === 'Bass' ? 'selected' : ''}>Bass</option>
                  </select>`
                : `<span class="text-xs text-gray-500">${esc(p.arrangement)}</span>`
            }
        </div>`;
    }).join('');
}

window.mpSetArrangement = function (arr) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    _ws.send(JSON.stringify({ type: 'set_arrangement', arrangement: arr }));
    if (_room && _room.players[_playerId]) {
        _room.players[_playerId].arrangement = arr;
    }
};

// ── Controls Visibility ────────────────────────────────────────────────

function _updateControls() {
    const hostControls = document.getElementById('mp-host-controls');
    const guestControls = document.getElementById('mp-guest-controls');
    const recSection = document.getElementById('mp-recording-section');

    if (hostControls) hostControls.classList.toggle('hidden', !_isHost);
    if (guestControls) guestControls.classList.toggle('hidden', _isHost);
    if (recSection) recSection.classList.toggle('hidden', !_isHost);
}

// ── Copy Room Code ─────────────────────────────────────────────────────

window.mpCopyCode = function () {
    if (!_roomCode) return;
    navigator.clipboard.writeText(_roomCode).then(() => {
        const toast = document.getElementById('mp-copy-toast');
        if (toast) {
            toast.classList.remove('opacity-0');
            toast.classList.add('opacity-100');
            setTimeout(() => {
                toast.classList.remove('opacity-100');
                toast.classList.add('opacity-0');
            }, 1500);
        }
    }).catch(() => {});
};

// ── Recording ──────────────────────────────────────────────────────────

window.mpToggleRecording = function () {
    if (!_isHost || !_ws) return;
    const toggle = document.getElementById('mp-rec-toggle');
    const enabling = toggle?.checked;
    _ws.send(JSON.stringify({
        type: enabling ? 'start_recording' : 'stop_recording',
    }));
};

let _recArmed = false;  // armed but not yet recording (waiting for play)

function _onRecordingState(recording) {
    const indicator = document.getElementById('mp-rec-indicator');
    const recToggle = document.getElementById('mp-rec-toggle');
    const guestRec = document.getElementById('mp-guest-rec-status');

    if (indicator) indicator.classList.toggle('hidden', !recording);
    if (recToggle) recToggle.checked = recording;
    _updatePlayerRecBtn(recording);

    if (recording) {
        _armRecording();
        if (!_isHost && guestRec) guestRec.classList.remove('hidden');
    } else {
        _recArmed = false;
        _stopAndUploadRecording();
        if (guestRec) setTimeout(() => guestRec.classList.add('hidden'), 3000);
    }
}

async function _armRecording() {
    // Get mic access and prepare MediaRecorder, but don't start yet — wait for play.
    try {
        // Use desktop bridge if available
        if (window.slopsmithDesktop?.audio?.startRecording) {
            _recArmed = true;
            const statusEl = _isHost
                ? document.getElementById('mp-rec-status')
                : document.getElementById('mp-guest-rec-info');
            if (statusEl) statusEl.textContent = 'Armed — will record when song plays';
            return;
        }

        _mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            }
        });
        _recordedChunks = [];

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        _mediaRecorder = new MediaRecorder(_mediaStream, { mimeType });

        _mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) _recordedChunks.push(e.data);
        };

        // Don't start yet — armed and waiting for playback
        _recArmed = true;

        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Armed — will record when song plays';
    } catch (e) {
        console.error('[MP] getUserMedia failed:', e);
        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Mic access denied: ' + e.message;
    }
}

function _startRecordingNow() {
    // Actually start the MediaRecorder — called when playback begins.
    if (!_recArmed || _isRecording) return;

    // Capture the song position when recording starts — this is the shared
    // reference both host and client agree on (synced via heartbeat).
    const audio = document.getElementById('audio');
    _recStartServerTime = audio ? audio.currentTime * 1000 : 0;  // ms into song

    if (window.slopsmithDesktop?.audio?.startRecording) {
        window.slopsmithDesktop.audio.startRecording();
        _isRecording = true;
        return;
    }

    if (_mediaRecorder && _mediaRecorder.state === 'inactive') {
        _recordedChunks = [];
        _mediaRecorder.start(1000);
        _isRecording = true;
        console.log('[MP] Recording started at song position:', (_recStartServerTime / 1000).toFixed(3), 's');

        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Recording...';
    }
}

function _stopRecording() {
    _isRecording = false;
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
        try { _mediaRecorder.stop(); } catch (e) { /* */ }
    }
    if (_mediaStream) {
        _mediaStream.getTracks().forEach(t => t.stop());
        _mediaStream = null;
    }
    _mediaRecorder = null;
}

async function _stopAndUploadRecording() {
    if (!_isRecording) return;

    // Desktop bridge
    if (window.slopsmithDesktop?.audio?.stopRecording) {
        const blob = await window.slopsmithDesktop.audio.stopRecording();
        _isRecording = false;
        if (blob) await _uploadBlob(blob, 'recording.wav');
        return;
    }

    if (!_mediaRecorder || _mediaRecorder.state === 'inactive') {
        _isRecording = false;
        return;
    }

    _mediaRecorder.stop();
    if (_mediaStream) {
        _mediaStream.getTracks().forEach(t => t.stop());
        _mediaStream = null;
    }

    // Wait for final chunks
    await new Promise(resolve => {
        _mediaRecorder.onstop = resolve;
    });

    _isRecording = false;

    if (_recordedChunks.length === 0) return;
    const blob = new Blob(_recordedChunks, { type: 'audio/webm' });
    _recordedChunks = [];

    await _uploadBlob(blob, 'recording.webm');
}

async function _uploadBlob(blob, filename) {
    const progressContainer = _isHost
        ? document.getElementById('mp-upload-progress')
        : document.getElementById('mp-guest-upload-progress');
    const progressBar = _isHost
        ? document.getElementById('mp-upload-bar')
        : document.getElementById('mp-guest-upload-bar');

    if (progressContainer) progressContainer.classList.remove('hidden');

    const formData = new FormData();
    formData.append('file', blob, filename);
    formData.append('player_id', _playerId);
    formData.append('start_server_time', String(_recStartServerTime));

    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/plugins/multiplayer/rooms/${_roomCode}/upload`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && progressBar) {
                progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
            }
        };
        xhr.onload = () => {
            if (progressBar) progressBar.style.width = '100%';
            setTimeout(() => {
                if (progressContainer) progressContainer.classList.add('hidden');
            }, 2000);
            resolve();
        };
        xhr.onerror = () => {
            console.error('[MP] Upload failed');
            if (progressContainer) progressContainer.classList.add('hidden');
            resolve();
        };
        xhr.send(formData);
    });
}

function _updateRecordingStatus(msg) {
    if (!_isHost) return;
    const statusEl = document.getElementById('mp-rec-status');
    const mixSection = document.getElementById('mp-mixdown-section');
    const mixStatus = document.getElementById('mp-mixdown-status');

    if (statusEl) {
        statusEl.textContent = `${msg.total_uploads}/${msg.total_players} recordings received`;
    }

    if (mixSection && msg.total_uploads > 0) {
        mixSection.classList.remove('hidden');
        if (mixStatus) {
            mixStatus.textContent = `${msg.total_uploads} track${msg.total_uploads !== 1 ? 's' : ''} ready to mix`;
        }
        _renderStemToggles();
    }
}

function _renderStemToggles() {
    const container = document.getElementById('mp-stem-toggles');
    if (!container) return;

    // Get stem names from the song info
    const info = (typeof highway !== 'undefined' && highway.getSongInfo) ? highway.getSongInfo() : null;
    const stems = (info && info.stems) || [];
    if (stems.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Also list player recordings
    const players = (_room && _room.players) || {};

    container.innerHTML =
        '<div class="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Include in mixdown</div>' +
        stems.map(s => {
            const id = s.id || s;
            return `<label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" class="mp-stem-cb accent-accent" data-stem="${esc(id)}" checked>
                ${esc(id)}
            </label>`;
        }).join('') +
        Object.keys(players).filter(pid => _room.recordings_received && _room.recordings_received.includes(pid)).map(pid => {
            const p = players[pid];
            return `<label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" class="mp-rec-cb accent-accent" data-player="${pid}" checked>
                ${esc(p.name)} (recording)
            </label>`;
        }).join('');
}

// ── Mixdown ────────────────────────────────────────────────────────────

window.mpTriggerMixdown = async function () {
    if (!_isHost || !_roomCode || !_playerId) return;
    const btn = document.getElementById('mp-btn-mixdown');
    if (btn) { btn.disabled = true; btn.textContent = 'Mixing...'; }

    // Read stem/recording checkboxes
    const includedStems = [];
    document.querySelectorAll('.mp-stem-cb').forEach(cb => {
        if (cb.checked) includedStems.push(cb.dataset.stem);
    });
    const includedRecordings = [];
    document.querySelectorAll('.mp-rec-cb').forEach(cb => {
        if (cb.checked) includedRecordings.push(cb.dataset.player);
    });

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/mixdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: _playerId,
                include_stems: includedStems,
                include_recordings: includedRecordings,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
            console.error('[MP] Mixdown failed:', data.error);
            return;
        }
        if (data.url) _onMixdownReady(data.url);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
        console.error('[MP] Mixdown error:', e);
    }
};

function _onMixdownReady(url) {
    const btn = document.getElementById('mp-btn-mixdown');
    const link = document.getElementById('mp-mixdown-link');
    const mixSection = document.getElementById('mp-mixdown-section');

    if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
    if (mixSection) mixSection.classList.remove('hidden');
    if (link) {
        link.href = url;
        link.classList.remove('hidden');
        link.textContent = 'Download Mixdown (MP3)';
    }
}

// ── Mini DAW Mixer ────────────────────────────────────────────────────

let _mixerCtx = null;       // AudioContext for preview
let _mixerTracks = [];      // [{id, label, type, url, buffer, source, gain, offset, volume, muted, waveCanvas}]
let _mixerPlaying = false;
let _mixerStartTime = 0;
let _mixerDuration = 0;
let _mixerRaf = null;
let _mixerDragTrack = null;
let _mixerDragStartX = 0;
let _mixerDragStartOffset = 0;

window.mpOpenMixer = async function () {
    if (!_roomCode) return;

    // Show mixer, hide room
    document.getElementById('mp-room-view').classList.add('hidden');
    document.getElementById('mp-mixer-view').classList.remove('hidden');

    // Fetch tracks
    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/tracks`);
        const data = await resp.json();
        if (data.error) { console.error('[MP] Tracks error:', data.error); return; }
        await _mixerLoadTracks(data.tracks);
    } catch (e) {
        console.error('[MP] Failed to load tracks:', e);
    }
};

window.mpCloseMixer = function () {
    _mixerStop();
    document.getElementById('mp-mixer-view').classList.add('hidden');
    document.getElementById('mp-room-view').classList.remove('hidden');
};

async function _mixerLoadTracks(trackList) {
    if (!_mixerCtx) _mixerCtx = new (window.AudioContext || window.webkitAudioContext)();

    _mixerTracks = [];
    const container = document.getElementById('mp-mixer-tracks');
    container.innerHTML = '<div class="p-4 text-xs text-gray-500">Loading audio tracks...</div>';

    for (const t of trackList) {
        const track = {
            id: t.id,
            label: t.label,
            type: t.type,
            url: t.url,
            buffer: null,
            source: null,
            gain: null,
            offset: t.start_ms || 0,  // ms offset from song start
            volume: 1.0,
            muted: false,
        };

        // Fetch and decode audio
        try {
            const resp = await fetch(t.url);
            const arrayBuf = await resp.arrayBuffer();
            track.buffer = await _mixerCtx.decodeAudioData(arrayBuf);
        } catch (e) {
            console.warn(`[MP] Failed to decode ${t.label}:`, e);
            continue;
        }

        _mixerTracks.push(track);
    }

    // Find max duration including offsets
    _mixerDuration = 0;
    for (const t of _mixerTracks) {
        const end = (t.offset / 1000) + t.buffer.duration;
        if (end > _mixerDuration) _mixerDuration = end;
    }

    _mixerRenderTracks();
    _mixerDrawRuler();
}

function _mixerRenderTracks() {
    const container = document.getElementById('mp-mixer-tracks');
    container.innerHTML = '';

    for (const t of _mixerTracks) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 px-3 py-2';
        row.dataset.trackId = t.id;

        // Label + controls
        const controls = document.createElement('div');
        controls.className = 'w-40 flex-shrink-0 space-y-1';
        controls.innerHTML = `
            <div class="text-xs text-white font-medium truncate" title="${esc(t.label)}">${esc(t.label)}</div>
            <div class="flex items-center gap-2">
                <button onclick="mpMixerToggleMute('${t.id}')" class="mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}" data-track="${t.id}">M</button>
                <button onclick="mpMixerSolo('${t.id}')" class="text-[10px] px-1.5 py-0.5 rounded bg-dark-600 text-gray-400 hover:bg-amber-900/50 hover:text-amber-400">S</button>
                <input type="range" min="0" max="100" value="${Math.round(t.volume * 100)}"
                    class="w-16 accent-accent" oninput="mpMixerSetVolume('${t.id}', this.value)">
                <span class="text-[10px] text-gray-500 w-8 mp-vol-label" data-track="${t.id}">${Math.round(t.volume * 100)}%</span>
            </div>
            <div class="flex items-center gap-1">
                <span class="text-[10px] text-gray-600">Offset:</span>
                <button onclick="mpMixerNudge('${t.id}', -50)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">-50ms</button>
                <button onclick="mpMixerNudge('${t.id}', -10)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">-10</button>
                <span class="text-[10px] text-gray-400 w-14 text-center mp-offset-label" data-track="${t.id}">${t.offset}ms</span>
                <button onclick="mpMixerNudge('${t.id}', 10)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">+10</button>
                <button onclick="mpMixerNudge('${t.id}', 50)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">+50ms</button>
            </div>`;
        row.appendChild(controls);

        // Waveform canvas (draggable)
        const waveWrap = document.createElement('div');
        waveWrap.className = 'flex-1 h-14 relative bg-dark-800 rounded overflow-hidden cursor-grab';
        const canvas = document.createElement('canvas');
        canvas.className = 'w-full h-full';
        canvas.style.display = 'block';
        waveWrap.appendChild(canvas);
        row.appendChild(waveWrap);
        container.appendChild(row);

        t.waveCanvas = canvas;

        // Drag to offset
        waveWrap.addEventListener('mousedown', (e) => {
            _mixerDragTrack = t;
            _mixerDragStartX = e.clientX;
            _mixerDragStartOffset = t.offset;
            waveWrap.style.cursor = 'grabbing';
            e.preventDefault();
        });

        // Draw waveform after layout
        requestAnimationFrame(() => _mixerDrawWaveform(t));
    }

    // Global mouse handlers for drag
    document.addEventListener('mousemove', _mixerOnDrag);
    document.addEventListener('mouseup', _mixerOnDragEnd);
}

function _mixerDrawWaveform(track) {
    const canvas = track.waveCanvas;
    if (!canvas || !track.buffer) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const data = track.buffer.getChannelData(0);
    const dur = track.buffer.duration;
    const totalW = _mixerDuration > 0 ? W : W;
    const pxPerSec = W / _mixerDuration;
    const offsetPx = (track.offset / 1000) * pxPerSec;
    const trackW = dur * pxPerSec;

    ctx.clearRect(0, 0, W, H);

    // Background for track extent
    const color = track.type === 'recording' ? '#2563eb' : '#059669';
    ctx.fillStyle = color + '20';
    ctx.fillRect(offsetPx, 0, trackW, H);

    // Waveform
    ctx.fillStyle = color + '80';
    const samples = data.length;
    const samplesPerPx = Math.max(1, Math.floor(samples / trackW));
    const mid = H / 2;

    for (let px = 0; px < trackW && px + offsetPx < W; px++) {
        const start = Math.floor((px / trackW) * samples);
        const end = Math.min(start + samplesPerPx, samples);
        let max = 0;
        for (let i = start; i < end; i++) {
            const v = Math.abs(data[i]);
            if (v > max) max = v;
        }
        const h = max * mid * 0.9;
        ctx.fillRect(offsetPx + px, mid - h, 1, h * 2);
    }

    // Label
    ctx.fillStyle = '#fff8';
    ctx.font = '10px sans-serif';
    ctx.fillText(track.label, offsetPx + 4, 12);
}

function _mixerOnDrag(e) {
    if (!_mixerDragTrack) return;
    const t = _mixerDragTrack;
    const canvas = t.waveCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pxPerMs = rect.width / (_mixerDuration * 1000);
    const dx = e.clientX - _mixerDragStartX;
    t.offset = Math.max(0, Math.round(_mixerDragStartOffset + dx / pxPerMs));
    const label = document.querySelector(`.mp-offset-label[data-track="${t.id}"]`);
    if (label) label.textContent = t.offset + 'ms';
    _mixerDrawWaveform(t);
}

function _mixerOnDragEnd() {
    if (_mixerDragTrack) {
        const wrap = _mixerDragTrack.waveCanvas?.parentElement;
        if (wrap) wrap.style.cursor = 'grab';
        _mixerDragTrack = null;
    }
}

function _mixerDrawRuler() {
    const canvas = document.getElementById('mp-mixer-ruler-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, W, H);

    const step = _mixerDuration > 60 ? 10 : _mixerDuration > 20 ? 5 : 1;
    ctx.fillStyle = '#888';
    ctx.font = '9px sans-serif';
    for (let t = 0; t <= _mixerDuration; t += step) {
        const x = (t / _mixerDuration) * W;
        ctx.fillRect(x, H - 4, 1, 4);
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, x + 2, H - 5);
    }
}

// ── Mixer playback (Web Audio) ──

function _mixerPlay() {
    if (!_mixerCtx || _mixerTracks.length === 0) return;
    if (_mixerCtx.state === 'suspended') _mixerCtx.resume();

    _mixerStartTime = _mixerCtx.currentTime;

    for (const t of _mixerTracks) {
        if (!t.buffer || t.muted) continue;
        const source = _mixerCtx.createBufferSource();
        source.buffer = t.buffer;
        const gain = _mixerCtx.createGain();
        gain.gain.value = t.volume;
        source.connect(gain).connect(_mixerCtx.destination);
        const offsetSec = t.offset / 1000;
        source.start(_mixerCtx.currentTime + offsetSec);
        t.source = source;
        t.gain = gain;
    }

    _mixerPlaying = true;
    _mixerUpdatePlayhead();
}

function _mixerStop() {
    for (const t of _mixerTracks) {
        if (t.source) {
            try { t.source.stop(); } catch (e) { /* */ }
            t.source = null;
        }
    }
    _mixerPlaying = false;
    if (_mixerRaf) { cancelAnimationFrame(_mixerRaf); _mixerRaf = null; }
    const playhead = document.getElementById('mp-mixer-playhead');
    if (playhead) playhead.style.left = '0%';
    const timeEl = document.getElementById('mp-mixer-time');
    if (timeEl) timeEl.textContent = '0:00.0';
    const btn = document.getElementById('mp-mixer-play');
    if (btn) btn.textContent = 'Preview';
}

function _mixerUpdatePlayhead() {
    if (!_mixerPlaying) return;
    const elapsed = _mixerCtx.currentTime - _mixerStartTime;
    const pct = Math.min(100, (elapsed / _mixerDuration) * 100);
    const playhead = document.getElementById('mp-mixer-playhead');
    if (playhead) playhead.style.left = pct + '%';
    const timeEl = document.getElementById('mp-mixer-time');
    if (timeEl) {
        const m = Math.floor(elapsed / 60);
        const s = (elapsed % 60).toFixed(1);
        timeEl.textContent = `${m}:${s.padStart(4, '0')}`;
    }
    if (elapsed >= _mixerDuration) {
        _mixerStop();
        return;
    }
    _mixerRaf = requestAnimationFrame(_mixerUpdatePlayhead);
}

window.mpMixerPlayPause = function () {
    if (_mixerPlaying) {
        _mixerStop();
    } else {
        _mixerPlay();
        const btn = document.getElementById('mp-mixer-play');
        if (btn) btn.textContent = 'Stop';
    }
};

window.mpMixerSeek = function (e) {
    // Not implemented for buffer sources (would need to restart all)
};

window.mpMixerToggleMute = function (trackId) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.muted = !t.muted;
    if (t.gain) t.gain.gain.value = t.muted ? 0 : t.volume;
    const btn = document.querySelector(`.mp-mute-btn[data-track="${trackId}"]`);
    if (btn) {
        btn.className = `mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}`;
    }
};

window.mpMixerSolo = function (trackId) {
    // Mute everything except this track
    for (const t of _mixerTracks) {
        t.muted = (t.id !== trackId);
        if (t.gain) t.gain.gain.value = t.muted ? 0 : t.volume;
        const btn = document.querySelector(`.mp-mute-btn[data-track="${t.id}"]`);
        if (btn) {
            btn.className = `mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}`;
        }
    }
};

window.mpMixerSetVolume = function (trackId, val) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.volume = parseFloat(val) / 100;
    if (t.gain && !t.muted) t.gain.gain.value = t.volume;
    const label = document.querySelector(`.mp-vol-label[data-track="${trackId}"]`);
    if (label) label.textContent = Math.round(t.volume * 100) + '%';
};

window.mpMixerNudge = function (trackId, deltaMs) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.offset = Math.max(0, t.offset + deltaMs);
    const label = document.querySelector(`.mp-offset-label[data-track="${trackId}"]`);
    if (label) label.textContent = t.offset + 'ms';
    _mixerDrawWaveform(t);
};

window.mpMixerExport = async function () {
    if (!_roomCode || !_playerId) return;
    const btn = document.getElementById('mp-mixer-export');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting...'; }

    // Collect mixer state
    const track_offsets = {};
    const track_volumes = {};
    const track_mutes = [];
    for (const t of _mixerTracks) {
        track_offsets[t.id] = t.offset;
        track_volumes[t.id] = t.volume;
        if (t.muted) track_mutes.push(t.id);
    }

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/mixdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: _playerId,
                track_offsets,
                track_volumes,
                track_mutes,
            }),
        });
        const data = await resp.json();
        if (btn) { btn.disabled = false; btn.textContent = 'Export Mix'; }
        if (data.error) {
            console.error('[MP] Export failed:', data.error);
            return;
        }
        if (data.url) {
            const link = document.getElementById('mp-mixer-download');
            if (link) {
                link.href = data.url;
                link.classList.remove('hidden');
                link.textContent = 'Download Mixdown (MP3)';
            }
        }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Export Mix'; }
        console.error('[MP] Export error:', e);
    }
};

// ── Audio ended hook (host sends song_ended) ───────────────────────────

(function () {
    const audio = document.getElementById('audio');
    if (audio) {
        audio.addEventListener('ended', () => {
            if (_isHost && _ws && _ws.readyState === WebSocket.OPEN && _room && _room.now_playing >= 0) {
                _ws.send(JSON.stringify({ type: 'song_ended' }));
            }
        });
    }
})();

// ── Debug hook ─────────────────────────────────────────────────────────
//
// window.slopsmithMultiplayerDebug surfaces a small, intentionally
// internal/unstable shape for inspecting the audio WS state from dev
// tools. Not a public API; subject to change between phases.

window.slopsmithMultiplayerDebug = {
    getAudioRxStats: _audioGetRxStats,
    getListenerState: () => ({
        broadcasterId: _audioListenerBroadcasterId,
        params: _audioListenerBroadcastParams,
        scheduledCount: _audioListenerScheduledSources.size,
        pendingDecodeCount: _audioListenerActiveDecoder
            ? _audioListenerActiveDecoder.pending.size
            : 0,
        hasContext: _audioListenerCtx !== null,
        hasDecoder: _audioListenerActiveDecoder !== null,
    }),
};

// ── Screen show/hide hook ──────────────────────────────────────────────

(function () {
    const origShowScreen = window.showScreen;
    window.showScreen = function (id) {
        origShowScreen(id);
        if (id === 'plugin-multiplayer') {
            _loadSettings();
            // Check if we have an active room
            const savedRoom = sessionStorage.getItem('mp_room');
            const savedPlayer = sessionStorage.getItem('mp_player');
            if (savedRoom && savedPlayer && _ws && _ws.readyState === WebSocket.OPEN) {
                _showRoomView();
            } else if (savedRoom && savedPlayer && !_ws) {
                // Try to reconnect both WSs under the same persisted
                // session_id (sessionStorage carried it over the screen
                // switch). _connectWS / _connectAudioWs read _sessionId
                // via _getOrMintSessionId on connect.
                _roomCode = savedRoom;
                _playerId = savedPlayer;
                _connectWS();
                _connectAudioWs();
                _showRoomView();
            } else {
                _showLobbyView();
            }
        }
    };
})();

})();
