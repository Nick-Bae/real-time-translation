// frontend/lib/useDeepgramProducer.ts
import { useRef, useState } from "react";

function wsDeepgramURL() {
  const env = process.env.NEXT_PUBLIC_WS_URL || "";
  try {
    if (env.startsWith("ws")) {
      const u = new URL(env);
      u.pathname = ""; u.search = ""; u.hash = "";
      return `${u.toString().replace(/\/$/, "")}/ws/stt/deepgram`;
    }
  } catch { }
  const u = new URL(window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = ""; u.search = ""; u.hash = "";
  return `${u.toString().replace(/\/$/, "")}/ws/stt/deepgram`;
}

type Status = "idle" | "starting" | "streaming" | "stopped" | "error";

export function useDeepgramProducer() {
  const [status, setStatus] = useState<Status>("idle");
  const [partial, setPartial] = useState("");
  const [lastCommit, setLastCommit] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    try {
      if (status === "streaming" || status === "starting") return;
      setStatus("starting");
      setErrorMsg(null);

      // Secure-context guard (AudioWorklet requirement)
      const origin = window.location.origin;
      const isSecure =
        window.isSecureContext || origin.startsWith("https://") || origin.includes("localhost");
      if (!isSecure) throw new Error("AudioWorklet requires a secure context (localhost or HTTPS).");

      // AudioContext + Worklet
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
      ctxRef.current = ctx;

      await ctx.audioWorklet.addModule("/workers/pcm-worklet-processor.js");

      // mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      });
      streamRef.current = stream;

      // nodes all on the SAME ctx
      const src = ctx.createMediaStreamSource(stream);

      const workletNode = new AudioWorkletNode(ctx, "pcm16-worklet", {
        numberOfInputs: 1,
        numberOfOutputs: 0,       // no outputs
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });

      // --- wiring ---
      // DO NOT: workletNode.connect(...)
      // mic -> worklet (for processing/port messages)
      src.connect(workletNode);

      // mic -> silent sink to keep graph alive
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(sink);
      sink.connect(ctx.destination);

      // expose port
      portRef.current = workletNode.port;

      if (ctx.state === "suspended") await ctx.resume();


      // WebSocket
      const url = wsDeepgramURL();
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        console.log('WS open:', ws!.url);
        workletNode!.port.onmessage = (ev) => {
          const msg = ev.data;
          if (msg && typeof msg === 'object' && !(msg instanceof ArrayBuffer)) {
            if ((msg as any).dbg) console.log('worklet dbg:', (msg as any).dbg);
            return;
          }
          const buf = msg as ArrayBuffer;
          console.log('TX -> WS bytes:', buf.byteLength);  // <— add this
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
        };
        setStatus("streaming");

        // keep the server stream from idling out when you're quiet
        if (!keepAliveRef.current) {
          keepAliveRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(new ArrayBuffer(640)); // ~20ms silence @16kHz mono 16-bit (320 samples * 2 bytes)
            }
          }, 2000);
        }

        // Pipe worker -> WS (handle rms/debug objects vs ArrayBuffers)
        portRef.current!.onmessage = (evt: MessageEvent) => {
          const data = evt.data;
          if (data && typeof data === "object" && !(data instanceof ArrayBuffer)) {
            // { dbg?: {sentKB}, rms?: number }
            if (data.rms != null) {
              // you can lift an onRms callback into this hook if you want to expose mic level
              // e.g., setMicRms(data.rms)
            }
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(data); // PCM16 @ 16k from your worker
        };
      };

      ws.onclose = () => {
        setStatus("stopped");
      };
      ws.onerror = () => {
        setErrorMsg("WebSocket error");
        setStatus("error");
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "error") {
            setErrorMsg(msg.message || "Server error");
            return;
          }
          if (msg.type === "stt.partial") setPartial(msg.text || "");
          if (msg.type === "translation") setLastCommit(msg.payload || "");
        } catch {
          /* ignore non-JSON */
        }
      };

      wsRef.current = ws;
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("error");
    }
  }

  function stop() {
    try {
      if (keepAliveRef.current) { clearInterval(keepAliveRef.current); keepAliveRef.current = null; }
      wsRef.current?.close(); wsRef.current = null;
      portRef.current?.close?.(); portRef.current = null;
      ctxRef.current?.close(); ctxRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    } finally {
      setStatus("stopped");
      setPartial("");
    }
  }

  return { status, partial, lastCommit, errorMsg, start, stop };
}
