// frontend/lib/useDeepgramProducer.ts
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    // Safari prefix — no `any` needed
  }
}

type Status = 'idle' | 'starting' | 'streaming' | 'stopped' | 'error';

type WsErrorMsg = { type: 'error'; message?: string };
type WsPartialMsg = { type: 'stt.partial'; text?: string };
type WsTranslationMsg = { type: 'translation'; payload?: string };
type WsMessage = WsErrorMsg | WsPartialMsg | WsTranslationMsg;

function isWsMessage(v: unknown): v is WsMessage {
  return typeof v === 'object' && v !== null && 'type' in v;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

function wsDeepgramURL(): string {
  const env = process.env.NEXT_PUBLIC_WS_URL || '';
  try {
    if (env.startsWith('ws')) {
      const u = new URL(env);
      u.pathname = ''; u.search = ''; u.hash = '';
      return `${u.toString().replace(/\/$/, '')}/ws/stt/deepgram`;
    }
  } catch {
    // fall through to build from window
  }
  const u = new URL(window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = ''; u.search = ''; u.hash = '';
  return `${u.toString().replace(/\/$/, '')}/ws/stt/deepgram`;
}

export function useDeepgramProducer() {
  const [status, setStatus] = useState<Status>('idle');
  const [partial, setPartial] = useState('');
  const [lastCommit, setLastCommit] = useState('');       // ✅ keep it
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start(): Promise<void> {
    try {
      if (status === 'streaming' || status === 'starting') return;
      setStatus('starting');
      setErrorMsg(null);

      // Secure-context guard (required for AudioWorklet)
      const isSecure = typeof window !== 'undefined' &&
        (window.isSecureContext ||
          window.location.origin.startsWith('https://') ||
          window.location.hostname === 'localhost');
      if (!isSecure) throw new Error('AudioWorklet requires a secure context (localhost or HTTPS).');

      // AudioContext + Worklet (typed, no `any`)
      const ACtor = window.AudioContext ?? window.webkitAudioContext;
      if (!ACtor) throw new Error('Web Audio API not supported');
      const ctx = new ACtor({ sampleRate: 48000 });
      ctxRef.current = ctx as AudioContext;

      await ctx.audioWorklet.addModule('/workers/pcm-worklet-processor.js');
      // ^ ensure this path & worklet name match your worklet file’s `registerProcessor` name

      // Mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const src = (ctx as AudioContext).createMediaStreamSource(stream);

      // This name must match your processor registration (e.g., "pcm-worklet" or "pcm16-worklet")
      const workletName = 'pcm-worklet';
      const workletNode = new AudioWorkletNode(ctx as AudioContext, workletName, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });

      // Wiring
      src.connect(workletNode);

      // Silent sink to keep the graph alive
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(sink);
      sink.connect(ctx.destination);

      portRef.current = workletNode.port;

      if (ctx.state === 'suspended') await ctx.resume();

      // WebSocket
      const url = wsDeepgramURL();
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setStatus('streaming');

        // Send PCM frames from worklet to WS
        portRef.current!.onmessage = (evt: MessageEvent<ArrayBuffer | { rms?: number; dbg?: unknown }>) => {
          const data = evt.data;
          if (data && typeof data === 'object' && !(data instanceof ArrayBuffer)) {
            // handle {rms, dbg} objects if your worklet sends them; otherwise ignore
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(data as ArrayBuffer);
        };

        // Keep-alive (optional): send tiny silence buffers to prevent idle timeouts
        if (!keepAliveRef.current) {
          keepAliveRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(new ArrayBuffer(320)); // ~10ms @ 16kHz mono 16-bit (160 samples * 2 bytes); adjust to your server expectation
            }
          }, 2000);
        }
      };

      ws.onclose = () => {
        setStatus('stopped');
      };
      ws.onerror = () => {
        setErrorMsg('WebSocket error');
        setStatus('error');
      };
      ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
        if (typeof e.data !== 'string') return; // parse text frames only
        try {
          const parsed: unknown = JSON.parse(e.data);
          if (!isWsMessage(parsed)) return;
          switch (parsed.type) {
            case 'error':
              setErrorMsg(parsed.message ?? 'Server error');
              break;
            case 'stt.partial':
              setPartial(parsed.text ?? '');
              break;
            case 'translation':
              setLastCommit(parsed.payload ?? '');
              break;
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      wsRef.current = ws;
    } catch (err: unknown) {
      setErrorMsg(errorMessage(err));
      setStatus('error');
    }
  }

  function stop(): void {
    try {
      if (keepAliveRef.current) {
        clearInterval(keepAliveRef.current);
        keepAliveRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;

      portRef.current?.close?.();
      portRef.current = null;

      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      ctxRef.current?.close();
      ctxRef.current = null;
    } finally {
      setStatus('stopped');
      setPartial('');
      setLastCommit('');
    }
  }

  // Cleanup on unmount
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, partial, lastCommit, errorMsg, start, stop };
}
