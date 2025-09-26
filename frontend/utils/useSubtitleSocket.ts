// utils/useSubtitleSocket.ts
"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type MsgInterimKR = { type: "interim_kr"; text: string };
type MsgFinalKR   = { type: "final_kr";  text: string };
type MsgFastFinal = { type: "fast_final"; en: string; from?: string };

type ServerMsg = MsgInterimKR | MsgFinalKR | MsgFastFinal | Record<string, unknown>;

function isInterim(m: ServerMsg): m is MsgInterimKR {
  return (m as any)?.type === "interim_kr" && typeof (m as any)?.text === "string";
}
function isFinalKR(m: ServerMsg): m is MsgFinalKR {
  return (m as any)?.type === "final_kr"  && typeof (m as any)?.text === "string";
}
function isFastFinal(m: ServerMsg): m is MsgFastFinal {
  return (m as any)?.type === "fast_final" && typeof (m as any)?.en === "string";
}

export function useSubtitleSocket(explicitUrl?: string) {
  const [connected, setConnected] = useState(false);
  const [krInterim, setKrInterim] = useState("");
  const [krFinal,   setKrFinal]   = useState("");
  const [enFinal,   setEnFinal]   = useState("");

  // simple throttle for interim updates
  const rafId = useRef(0);
  const interimBuf = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const stopRef = useRef(false);
  const backoffMs = useRef(0);

  // Resolve the URL:
  // 1) explicit param wins
  // 2) NEXT_PUBLIC_WS_URL (e.g. ws://host:8000/ws/translate)
  // 3) fallback to current origin + /ws/translate (client-only)
  const url = useMemo(() => {
    if (explicitUrl) return explicitUrl;
    if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_WS_URL) {
      return process.env.NEXT_PUBLIC_WS_URL!;
    }
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws/translate";
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    return ""; // SSR placeholder; hook won’t connect until client
  }, [explicitUrl]);

  useEffect(() => {
    if (!url) return; // avoid SSR issues
    stopRef.current = false;

    const scheduleReconnect = () => {
      if (stopRef.current) return;
      backoffMs.current = Math.min(backoffMs.current * 2 || 600, 8000);
      const jitter = 0.5 + Math.random() * 0.5;
      const delay = Math.round(backoffMs.current * jitter);
      setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopRef.current) return;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          backoffMs.current = 0;
        };

        ws.onclose = () => {
          setConnected(false);
          wsRef.current = null;
          scheduleReconnect();
        };

        ws.onerror = () => {
          // will be followed by onclose
        };

        ws.onmessage = (e) => {
          try {
            const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
            const msg: ServerMsg = JSON.parse(raw);

            if (isInterim(msg)) {
              interimBuf.current = msg.text || "";
              if (!rafId.current) {
                rafId.current = requestAnimationFrame(() => {
                  rafId.current = 0;
                  setKrInterim(interimBuf.current || "");
                  interimBuf.current = null;
                });
              }
            } else if (isFinalKR(msg)) {
              const t = (msg.text || "").trim();
              setKrFinal(t);
              setKrInterim(""); // clear preview once we commit
            } else if (isFastFinal(msg)) {
              const t = (msg.en || "").trim();
              if (t) setEnFinal(t);
            }
          } catch {
            // ignore non-JSON / pings
          }
        };
      } catch {
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      stopRef.current = true;
      if (rafId.current) cancelAnimationFrame(rafId.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, [url]);

  return { connected, krInterim, krFinal, enFinal };
}
