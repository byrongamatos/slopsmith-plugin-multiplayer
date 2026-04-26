// Slopsmith Multiplayer — capture AudioWorkletProcessor
//
// Drains the broadcaster's MediaStreamSource at the AudioContext sample
// rate (48 kHz in v1) and posts fixed-size Float32Array chunks back to
// the main thread. Worklet runs in the dedicated AudioWorkletGlobalScope
// rendering thread; main-thread interval slicing + WebCodecs encode +
// SMAU frame build live in screen.js.
//
// Each `process()` call hands us a 128-sample render quantum (~2.67 ms
// at 48 kHz). PostMessaging on every quantum would be a needless
// per-frame allocation + cross-thread hop, so the worklet accumulates
// up to `chunkSize` samples (default 480 = ~10 ms) and emits one
// Float32Array per chunk.
//
// **Output behaviour.** The processor declares one output (so the node
// can be connected to a rendered graph — Web Audio doesn't reliably
// pull on nodes that are not reachable from `ctx.destination`), but
// `process()` doesn't write to it. Web Audio leaves untouched output
// channels zero-filled, so the silent output contributes no audio
// when routed through the main-thread silent-sink (`gain = 0`) to
// destination. The connection's only purpose is to keep the worklet
// on the rendered path so its `process()` callback fires reliably
// across browsers.
//
// **Distribution note.** This file is the source of truth for the
// worklet, but slopsmith core's plugin loader serves only the single
// `screen.js` entry point per plugin (no generic asset path). The
// browser-side worklet is therefore loaded from a Blob URL whose body
// is an inlined copy of this code in screen.js. Keep both in sync.

class CaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this._chunkSize = opts.chunkSize || 480;
        this._chunk = new Float32Array(this._chunkSize);
        this._chunkPos = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || !input[0]) return true;
        const src = input[0];
        let srcPos = 0;
        while (srcPos < src.length) {
            const space = this._chunkSize - this._chunkPos;
            const remaining = src.length - srcPos;
            const n = space < remaining ? space : remaining;
            // src is a Float32Array view into the worklet's render
            // buffer; copy-into-our-chunk so we don't post a transient
            // view that might be overwritten before main thread reads.
            this._chunk.set(src.subarray(srcPos, srcPos + n), this._chunkPos);
            this._chunkPos += n;
            srcPos += n;
            if (this._chunkPos === this._chunkSize) {
                // Transfer ownership of this chunk's buffer; allocate
                // a fresh one for the next batch.
                this.port.postMessage(this._chunk, [this._chunk.buffer]);
                this._chunk = new Float32Array(this._chunkSize);
                this._chunkPos = 0;
            }
        }
        return true;
    }
}

registerProcessor('slopsmith-capture-processor', CaptureProcessor);
