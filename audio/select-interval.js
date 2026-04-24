// Slopsmith Multiplayer — interval-quantized peer audio
// Picks the number of beats per Ninjam-style interval based on the chart's BPM.
//
// Always picks a whole-measure (or multi-measure) interval — never sub-measure.
// Default: 4 beats (one measure of 4/4). For very fast charts where one measure
// would be shorter than MIN_DURATION_SEC (so the encode/send budget per interval
// shrinks to nothing), bump to 8 beats. Slow charts where one measure exceeds
// MAX_DURATION_SEC are accepted as-is — a longer-than-target interval is musical;
// a half-measure interval is not.
//
// See PROTOCOL.md for the algorithm rationale and the BPM→beats decision table.
//
// Exposed as both a CommonJS module (for node-based tests) and a browser global
// under window.slopsmithMultiplayer.selectInterval.

(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.slopsmithMultiplayer = window.slopsmithMultiplayer || {};
        window.slopsmithMultiplayer.selectInterval = api.selectInterval;
        window.slopsmithMultiplayer.intervalDuration = api.intervalDuration;
    }
})(this, function () {

    var MIN_DURATION_SEC = 1.0;
    var MAX_DURATION_SEC = 3.0;
    var DEFAULT_BEATS = 4;
    var FAST_TEMPO_BEATS = 8;

    function selectInterval(bpm) {
        if (!isFinite(bpm) || bpm <= 0) return DEFAULT_BEATS;
        var secondsPerBeat = 60 / bpm;
        if (DEFAULT_BEATS * secondsPerBeat < MIN_DURATION_SEC) {
            return FAST_TEMPO_BEATS;
        }
        return DEFAULT_BEATS;
    }

    function intervalDuration(bpm, beats) {
        if (!isFinite(bpm) || bpm <= 0 || !isFinite(beats) || beats <= 0) return 0;
        return (60 / bpm) * beats;
    }

    return {
        selectInterval: selectInterval,
        intervalDuration: intervalDuration,
        MIN_DURATION_SEC: MIN_DURATION_SEC,
        MAX_DURATION_SEC: MAX_DURATION_SEC,
        DEFAULT_BEATS: DEFAULT_BEATS,
        FAST_TEMPO_BEATS: FAST_TEMPO_BEATS,
    };
});
