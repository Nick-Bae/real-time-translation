// Emits 16kHz mono PCM16LE frames (20ms -> 320 samples -> 640 bytes)
// Also posts {rms} every ~100ms for UI levels.
class PCM16Worklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = new Float32Array(0); // accumulate @ 48k
    this._sentBytes = 0;
    this._lastDbg = currentTime;
    this._lastRms = currentTime;
  }

  _downsampleTo16k(float48) {
    // 48k -> 16k by simple 3:1 average (fast and fine for STT)
    const inLen = float48.length;
    const outLen = Math.floor(inLen / 3);
    const out = new Int16Array(outLen);
    let j = 0;
    for (let i = 0; i + 2 < inLen; i += 3) {
      const s = (float48[i] + float48[i + 1] + float48[i + 2]) / 3;
      let v = Math.max(-1, Math.min(1, s));
      out[j++] = (v * 0x7fff) | 0;
    }
    return out;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0];
    if (!ch0) return true;

    // append chunk (48k)
    const old = this._acc;
    const next = new Float32Array(old.length + ch0.length);
    next.set(old, 0);
    next.set(ch0, old.length);
    this._acc = next;

    // frame size: 20ms @48k = 960 samples
    const FRAME_48K = 960;

    while (this._acc.length >= FRAME_48K) {
      const chunk48 = this._acc.subarray(0, FRAME_48K);
      const rest = this._acc.subarray(FRAME_48K);
      this._acc = new Float32Array(rest.length);
      this._acc.set(rest, 0);

      // RMS ~every 100ms
      if (currentTime - this._lastRms >= 0.1) {
        let sum = 0;
        for (let i = 0; i < chunk48.length; i++) sum += chunk48[i] * chunk48[i];
        const rms = Math.sqrt(sum / chunk48.length);
        this.port.postMessage({ rms });
        this._lastRms = currentTime;
      }

      // downsample -> Int16 @ 16k (320 samples => 640 bytes)
      const pcm16 = this._downsampleTo16k(chunk48);
      const ab = pcm16.buffer;
      this.port.postMessage(ab, [ab]);
      this._sentBytes += ab.byteLength;
    }

    // heartbeat ~0.5s
    if (currentTime - this._lastDbg >= 0.5) {
      this.port.postMessage({ dbg: { sentKB: Math.round(this._sentBytes / 1024) } });
      this._lastDbg = currentTime;
    }
    return true;
  }
}

registerProcessor('pcm16-worklet', PCM16Worklet);
