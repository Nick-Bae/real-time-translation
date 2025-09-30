// frontend/pages/producer.tsx
import { useRef, useState } from "react";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

// Messages you expect from the server
type WsErrorMsg = { type: 'error'; message?: string };
type WsPartialMsg = { type: 'stt.partial'; text?: string };
type WsTranslationMsg = { type: 'translation'; payload?: string };

type WsMessage = WsErrorMsg | WsPartialMsg | WsTranslationMsg;

// Type guard for parsed JSON
function isWsMessage(v: unknown): v is WsMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    typeof (v as { type: unknown }).type === 'string'
  );
}

// Safe error -> string
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

function wsDeepgramURL() {
  const env = process.env.NEXT_PUBLIC_WS_URL || "";
  try {
    if (env.startsWith("ws")) {
      const u = new URL(env);
      u.pathname = ""; u.search = ""; u.hash = "";
      return `${u.toString().replace(/\/$/, "")}/ws/stt/deepgram`;
    }
  } catch {}
  const u = new URL(window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = ""; u.search = ""; u.hash = "";
  return `${u.toString().replace(/\/$/, "")}/ws/stt/deepgram`;
}

export default function Producer() {
  const [status, setStatus] = useState<"idle"|"starting"|"streaming"|"stopped"|"error">("idle");
  const [partial, setPartial] = useState("");
  const [lastCommit, setLastCommit] = useState("");
  const [errorMsg, setErrorMsg] = useState<string|null>(null);

  const wsRef = useRef<WebSocket|null>(null);
  const portRef = useRef<MessagePort|null>(null);
  const ctxRef = useRef<AudioContext|null>(null);
  const streamRef = useRef<MediaStream|null>(null);

  async function start(): Promise<void> {
  try {
    if (status === 'streaming') return;
    setStatus('starting');
    setErrorMsg(null);

    // AudioContext (typed, no `any`)
    const ACtor = window.AudioContext ?? window.webkitAudioContext;
    if (!ACtor) throw new Error('Web Audio API not supported');

    const ctx = new ACtor({ sampleRate: 48000 });
    ctxRef.current = ctx as AudioContext; // both are structurally compatible

    // Worklet
    await ctx.audioWorklet.addModule('/workers/pcm-worklet-processor.js');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;

    const src = (ctx as AudioContext).createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx as AudioContext, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    src.connect(worklet);
    portRef.current = worklet.port;

    // WebSocket
    const url = wsDeepgramURL();
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => setStatus('streaming');
    ws.onclose = () => setStatus('stopped');
    ws.onerror = () => {
      setErrorMsg('WebSocket error');
      setStatus('error');
    };

    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      try {
        if (typeof e.data !== 'string') return; // we only JSON-parse text frames
        const parsed: unknown = JSON.parse(e.data);
        if (!isWsMessage(parsed)) return;

        switch (parsed.type) {
          case 'error':
            setErrorMsg(parsed.message ?? 'Server error');
            return;
          case 'stt.partial':
            setPartial(parsed.text ?? '');
            return;
          case 'translation':
            setLastCommit(parsed.payload ?? '');
            return;
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    wsRef.current = ws;

    // AudioWorklet -> WS (PCM 16-bit frames). Type the message as ArrayBuffer.
    portRef.current.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(evt.data);
      }
    };
  } catch (err: unknown) {
    setErrorMsg(errorMessage(err));   // ✅ no `any`
    setStatus('error');
  }
}

  function stop() {
    try {
      wsRef.current?.close(); wsRef.current = null;
      portRef.current?.close?.(); portRef.current = null;
      ctxRef.current?.close(); ctxRef.current = null;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    } finally {
      setStatus("stopped"); setPartial("");
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h1>Producer (Deepgram)</h1>
      <p>Status: <b>{status}</b></p>
      {errorMsg && <p style={{color:"tomato"}}>Error: {errorMsg}</p>}
      <button onClick={start} disabled={status==="streaming"}>Start</button>
      <button onClick={stop} disabled={status!=="streaming"}>Stop</button>

      <h3>Partial</h3>
      <div style={{ fontSize: 20, minHeight: 32 }}>{partial}</div>

      <h3>Last Commit (translated)</h3>
      <div style={{ fontSize: 24, minHeight: 40 }}>{lastCommit}</div>
    </div>
  );
}
