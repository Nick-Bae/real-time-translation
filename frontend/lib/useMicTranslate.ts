export type MicCtl = { start: () => Promise<void>; stop: () => Promise<void> };

type ReconnectOpts = {
  minDelayMs?: number;   // first retry delay
  maxDelayMs?: number;   // cap delay
  maxRetries?: number;   // 0 = infinite
};

// --- add near the top of useMicTranslate.ts where your types live ---

// lib/useMicTranslate.ts

export type InterimKrMsg = { type: "interim_kr"; text: string };
export type FinalKrMsg   = { type: "final_kr";  text: string; seq?: number };
export type FastFinalMsg = {
  type: "fast_final";
  en: string;
  from: "google";
  dst?: string;
  origin?: string;
  score?: number;
  seq?: number;
};

// NEW message kinds
export type CommitMsg = {
  type: "commit";
  payload: string;   // KO clause text
  src?: string;      // e.g., "ko"
  dst?: string;      // e.g., "en"
};

export type ServerTranslationMsg = {
  type: "translation";
  lang?: string;     // e.g., "en"
  payload: string;   // translated text
  meta?: Record<string, unknown>;
};

export type IdleTimeoutMsg = {
  type: "idle_timeout";
  seconds?: number;
};

// Final union (replace your existing one with this)
export type WsMsg =
  | InterimKrMsg
  | FinalKrMsg
  | FastFinalMsg
  | CommitMsg
  | ServerTranslationMsg
  | IdleTimeoutMsg;


function throttle(fn: (...args: any[]) => void, ms: number) {
  let last = 0;
  let timer: any = null;
  return (...args: any[]) => {
    const now = Date.now();
    const remain = ms - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, remain);
    }
  };
}

export function startMicStream(
  wsUrl: string,
  onMsg: (m: WsMsg) => void,
  onRms?: (rms: number) => void,
  reconnectOpts: ReconnectOpts = {}
): MicCtl {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let stream: MediaStream | null = null;
  let sink: GainNode | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // buffer PCM frames while WS is not OPEN
  const pending: ArrayBuffer[] = [];

  // backoff settings
  const MIN = reconnectOpts.minDelayMs ?? 800;
  const MAX = reconnectOpts.maxDelayMs ?? 8000;
  const MAX_RETRIES = reconnectOpts.maxRetries ?? 0; // 0 = infinite
  let attempts = 0;
  let stopped = false; // set true on .stop() to disable reconnects

  function scheduleReconnect(reason: string) {
    if (stopped) return;
    if (MAX_RETRIES > 0 && attempts >= MAX_RETRIES) {
      console.warn('[WS] reconnect: max retries reached');
      return;
    }
    const base = Math.min(MAX, MIN * Math.pow(2, attempts));
    const jitter = Math.random() * base * 0.2; // 0–20% jitter
    const delay = Math.floor(base + jitter);
    attempts++;
    console.warn(`[WS] reconnect in ${delay}ms (attempt ${attempts}) – ${reason}`);
    reconnectTimer && clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectWs(), delay);
  }

  function bindWorkletPort() {
    if (!workletNode) return;
    workletNode.port.onmessage = (ev) => {
      const m = ev.data;

      // small JSON objects from the worklet
      if (m && typeof m === 'object' && !(m instanceof ArrayBuffer) && !ArrayBuffer.isView(m)) {
        if ((m as any).rms != null) onRms?.(Number((m as any).rms));
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

      const s = ws;
      if (s && s.readyState === WebSocket.OPEN) {
        s.send(buf);
      } else {
        pending.push(buf);
      }
    };
  }

  async function initAudio() {
    if (audioCtx) return; // already initialized
    const origin = window.location.origin;
    const workletUrl = `${origin}/workers/pcm-worklet-processor.js`;

    // secure context check
    const isSecure =
      window.isSecureContext || origin.startsWith('https://') || origin.includes('localhost');
    if (!isSecure) throw new Error('AudioWorklet requires a secure context (localhost or HTTPS).');

    // probe file
    const probe = await fetch(workletUrl, { cache: 'no-store' });
    if (!probe.ok) throw new Error(`Worklet not reachable: ${workletUrl} (HTTP ${probe.status})`);
    console.log('Worklet fetch OK. First bytes:', (await probe.clone().text()).slice(0, 80));

    // mic
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });

    // audio graph
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.audioWorklet.addModule(workletUrl);
    console.log('AudioWorklet addModule OK:', workletUrl, 'sampleRate=', audioCtx.sampleRate);

    const src = audioCtx.createMediaStreamSource(stream);

    // one output so we can connect to a silent sink (keeps graph alive)
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

    if (audioCtx.state === 'suspended') await audioCtx.resume();

    bindWorkletPort();
  }

  function connectWs() {
    if (stopped) return;
    const s = new WebSocket(wsUrl);
    ws = s;
    s.binaryType = 'arraybuffer';

    s.onopen = () => {
      console.log('WS open:', s.url);
      attempts = 0; // reset backoff on success

      // keep-alive (send ~20ms “silence” every 2s)
      if (!keepAlive) {
        keepAlive = setInterval(() => {
          const sock = ws;
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(new ArrayBuffer(640));
          }
        }, 2000);
      }

      // flush queued frames
      while (pending.length && s.readyState === WebSocket.OPEN) {
        s.send(pending.shift()!);
      }
    };

    s.onmessage = (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        const m = JSON.parse(raw) as WsMsg;  // <-- union now includes commit/translation
        onMsg(m);
      } catch {
        /* ignore non-JSON */
      }
    };


    s.onclose = (e) => {
      console.warn('WS closed', e.code, e.reason);
      // clear keepalive; we’ll recreate on next open
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      scheduleReconnect(`code=${e.code} reason=${e.reason || 'n/a'}`);
    };

    s.onerror = (e) => {
      console.error('WS error', e);
      // error often followed by onclose; if not, schedule a reconnect anyway
    };
  }

  async function start() {
    stopped = false;
    await initAudio();   // (idempotent) set up mic/worklet/sink once
    connectWs();         // connect or reconnect
  }

  async function stop() {
    stopped = true;
    try {
      reconnectTimer && clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      pending.length = 0;

      if (workletNode) workletNode.port.onmessage = null as any;
      if (workletNode) workletNode.disconnect();
      if (sink) sink.disconnect();

      const s = ws;
      if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
        try { s.close(); } catch { }
      }
      ws = null;

      if (audioCtx) await audioCtx.close();
      audioCtx = null;

      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
    } catch { /* no-op */ }
  }

  return { start, stop };
}
