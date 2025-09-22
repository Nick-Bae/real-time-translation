// frontend/lib/useMicTranslate.ts
export type WsMsg =
  | { type: 'interim_kr'; text: string }
  | { type: 'final_kr';  text: string }
  | { type: 'fast_final'; en: string; from: 'google' };

export type MicCtl = { start: () => Promise<void>; stop: () => Promise<void> };

export function startMicStream(
  wsUrl: string,
  onMsg: (m: WsMsg) => void,
  onRms?: (rms: number) => void
): MicCtl {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let stream: MediaStream | null = null;
  let sink: GainNode | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  // Buffer PCM frames until the WS is OPEN
  const pending: ArrayBuffer[] = [];
  let wsOpen = false;

  async function start() {
    const origin = window.location.origin;
    const workletUrl = `${origin}/workers/pcm-worklet-processor.js`;

    // Secure context (required for AudioWorklet)
    const isSecure =
      window.isSecureContext || origin.startsWith('https://') || origin.includes('localhost');
    if (!isSecure) throw new Error('AudioWorklet requires a secure context (localhost or HTTPS).');

    // Verify the worklet file is served
    const probe = await fetch(workletUrl, { cache: 'no-store' });
    if (!probe.ok) throw new Error(`Worklet not reachable: ${workletUrl} (HTTP ${probe.status})`);
    console.log('Worklet fetch OK. First bytes:', (await probe.clone().text()).slice(0, 80));

    // Mic
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });

    // Audio graph
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.audioWorklet.addModule(workletUrl);
    console.log('AudioWorklet addModule OK:', workletUrl, 'sampleRate=', audioCtx.sampleRate);

    const src = audioCtx.createMediaStreamSource(stream);

    // ONE output so we can connect to a silent sink (keeps graph alive)
    workletNode = new AudioWorkletNode(audioCtx, 'pcm16-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    sink = audioCtx.createGain();
    sink.gain.value = 0;

    // mic -> worklet -> sink -> destination
    src.connect(workletNode);
    workletNode.connect(sink);
    sink.connect(audioCtx.destination);

    // Forward worker messages immediately; queue frames until WS is open
    workletNode.port.onmessage = (ev) => {
      const m = ev.data;

      // small JSON objects from the worklet
      if (m && typeof m === 'object' && !(m instanceof ArrayBuffer) && !ArrayBuffer.isView(m)) {
        if ((m as any).rms != null) onRms?.(Number((m as any).rms));
        // if ((m as any).dbg) console.log('worklet dbg', (m as any).dbg);
        return;
      }

      // normalize to ArrayBuffer (handles ArrayBuffer or TypedArray)
      const buf: ArrayBuffer =
        m instanceof ArrayBuffer ? m :
        (ArrayBuffer.isView(m) ? (m as ArrayBufferView).buffer : null as any);

      if (!buf) {
        console.warn('Worklet posted unknown payload:', m);
        return;
      }
      console.log('TX -> WS bytes:', buf.byteLength);

      // Use a local snapshot of ws to satisfy TS and avoid races
      const s = ws;
      if (s && s.readyState === WebSocket.OPEN) {
        // send immediately
        // console.log('TX -> WS bytes:', buf.byteLength);
        s.send(buf);
      } else {
        // queue until socket opens
        pending.push(buf);
      }
    };

    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // WebSocket
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsOpen = true;
      const s = ws; // snapshot
      if (!s) return;
      console.log('WS open:', s.url);

      // keep-alive
      if (!keepAlive) {
        keepAlive = setInterval(() => {
          const ss = ws; // snapshot inside timer
          if (ss && ss.readyState === WebSocket.OPEN) {
            ss.send(new ArrayBuffer(640)); // ~20ms silence @16kHz mono 16-bit
          }
        }, 2000);
      }

      // flush frames queued before the socket opened
      while (pending.length) {
        const ss = ws;
        if (!ss || ss.readyState !== WebSocket.OPEN) break;
        const frame = pending.shift()!;
        ss.send(frame);
      }
    };

    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
        onMsg(m);
      } catch {
        /* ignore non-JSON */
      }
    };

    ws.onclose = (e) => {
      wsOpen = false;
      console.log('WS closed', e.code, e.reason);
    };

    ws.onerror = (e) => console.error('WS error', e);
  }

  async function stop() {
    try {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      pending.length = 0;
      if (workletNode) workletNode.port.onmessage = null!;
      if (workletNode) workletNode.disconnect();
      if (sink) sink.disconnect();
      if (audioCtx) await audioCtx.close();
      if (stream) stream.getTracks().forEach(t => t.stop());
      const s = ws;
      if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) s.close();
    } catch { /* no-op */ }
    ws = null; audioCtx = null; workletNode = null; stream = null; sink = null; wsOpen = false;
  }

  return { start, stop };
}
