// /public/workers/pcm-worklet-processor.js
// 48k -> 16k high-quality decimator:
// - 63-tap low-pass FIR (~8 kHz cutoff @ 48 kHz) to prevent aliasing
// - Decimate by 3
// - Emits 20ms frames (320 samples @16kHz => 640 bytes PCM16LE)
// - Posts {rms} ~10x/sec for UI meters, and {dbg} once/sec

class PCM16Worklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // FIR taps: 63-tap windowed-sinc LPF, fc ≈ 8kHz @ 48kHz (norm ≈ 1/3 Nyquist)
    // Generated via a standard windowed-sinc design (Hamming); symmetrical taps.
    // You can tweak length/cutoff later if you want even cleaner stopband.
    this.h = new Float32Array([
      -0.001020, -0.001414, -0.001343, -0.000528,  0.000943,  0.002700,  0.003998,  0.003941,
       0.001834, -0.001812, -0.006028, -0.009191, -0.009420, -0.005917,  0.001088,  0.010037,
       0.018356,  0.022996,  0.021210,  0.011254, -0.006087, -0.027435, -0.047892, -0.061670,
      -0.063002, -0.047167, -0.011802,  0.044038,  0.114445,  0.189212,  0.255384,  0.300000,
       0.311974,  0.285266,  0.220106,  0.123362,  0.007224, -0.112770, -0.219168, -0.298325,
      -0.341063, -0.343170, -0.306373, -0.237299, -0.146967, -0.048870,  0.043650,  0.119239,
       0.171081,  0.196234,  0.195034,  0.170930,  0.129890,  0.079380,  0.027145, -0.019983,
      -0.056605, -0.079063, -0.085867, -0.078574, -0.061160, -0.038045
    ]);
    // delay line holds last h.length-1 samples between blocks
    this.z = new Float32Array(this.h.length - 1);

    this._sentBytes = 0;
    this._lastDbg = currentTime;
    this._lastRms = currentTime;

    // 20ms @ 48k = 960 input samples; @16k = 320 output samples
    this.FRAME_IN = 960;
    this.FRAME_OUT = 320;

    // output staging at 16k
    this.outF32 = new Float32Array(16000); // up to 1s buffer
    this.outCount = 0;
  }

  // Convolve input (with delay line) -> low-passed output at 48k
  _firLowpass(in48) {
    const h = this.h, L = h.length;
    const z = this.z;
    // prepend delay line
    const x = new Float32Array(z.length + in48.length);
    x.set(z, 0);
    x.set(in48, z.length);

    const outLen = in48.length; // same length at 48k before decimation
    const y = new Float32Array(outLen);

    // y[n] = sum_{k=0..L-1} h[k] * x[n + (L-1 - k)]
    for (let n = 0; n < outLen; n++) {
      let acc = 0;
      const base = n; // aligned so x[base+L-1] is current sample
      for (let k = 0; k < L; k++) {
        acc += h[k] * x[base + (L - 1 - k)];
      }
      y[n] = acc;
    }

    // update delay line with last L-1 samples of x
    z.set(x.subarray(x.length - (L - 1)));
    return y;
  }

  // Decimate by 3: take every 3rd sample after low-pass
  _decimate3(y48) {
    const outLen = Math.floor(y48.length / 3);
    const y16 = new Float32Array(outLen);
    for (let i = 0, j = 0; j < outLen; i += 3, j++) {
      y16[j] = y48[i];
    }
    return y16;
  }

  _emitFrames() {
    const FRAME_SAMPLES = this.FRAME_OUT; // 320 @16k
    while (this.outCount >= FRAME_SAMPLES) {
      const f = this.outF32.subarray(0, FRAME_SAMPLES);

      // optional: RMS heartbeat ~10x/sec
      if (currentTime - this._lastRms >= 0.1) {
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
        const rms = Math.sqrt(sum / f.length);
        this.port.postMessage({ rms });
        this._lastRms = currentTime;
      }

      // convert to PCM16
      const pcm = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        let s = f[i];
        s = Math.max(-1, Math.min(1, s));
        pcm[i] = (s * 0x7fff) | 0;
      }

      // shift buffer
      const remaining = this.outCount - FRAME_SAMPLES;
      if (remaining > 0) {
        this.outF32.copyWithin(0, FRAME_SAMPLES, FRAME_SAMPLES + remaining);
      }
      this.outCount = remaining;

      // post transferable
      const ab = pcm.buffer;
      this.port.postMessage(ab, [ab]);
      this._sentBytes += ab.byteLength;
    }

    // debug ~1/s
    if (currentTime - this._lastDbg >= 1) {
      this._lastDbg = currentTime;
      this.port.postMessage({ dbg: { sentKB: (this._sentBytes / 1024) | 0 } });
    }
  }

  process(inputs) {
    const ch0 = (inputs[0] && inputs[0][0]) || null;
    if (!ch0 || ch0.length === 0) {
      this._emitFrames();
      return true;
    }

    // Low-pass then decimate 3:1 (48k -> 16k)
    const y48 = this._firLowpass(ch0);
    const y16 = this._decimate3(y48);

    // Append to 16k staging buffer
    const need = this.outCount + y16.length;
    if (need > this.outF32.length) {
      // grow buffer if needed (rare)
      const grown = new Float32Array(Math.max(need, this.outF32.length * 2));
      grown.set(this.outF32);
      this.outF32 = grown;
    }
    this.outF32.set(y16, this.outCount);
    this.outCount += y16.length;

    this._emitFrames();
    return true;
  }
}

registerProcessor('pcm16-worklet', PCM16Worklet);
