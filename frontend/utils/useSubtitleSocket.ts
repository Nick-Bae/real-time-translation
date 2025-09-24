// utils/useSubtitleSocket.ts
import { useEffect, useMemo, useRef, useState } from "react";

type ServerMsg =
    | { type: "interim_kr"; text: string }
    | { type: "final_kr"; text: string }
    | { type: "fast_final"; en: string; from?: string }

export function useSubtitleSocket(wsUrl?: string) {
    const url = wsUrl || process.env.NEXT_PUBLIC_WS_URL || "";
    const [connected, setConnected] = useState(false);

    // live subtitles
    const [krInterim, setKrInterim] = useState("");
    const [krFinal, setKrFinal] = useState("");
    const [enFinal, setEnFinal] = useState("");

    // simple “debounce” for interim flicker (renders at most ~15 fps)
    const rafId = useRef(0);
    const pendingInterim = useRef<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const backoff = useRef(0); // ms
    const stopFlag = useRef(false);

    // utils/useSubtitleSocket.ts
    const resolvedUrl = useMemo(() => {
        try {
            if (url.startsWith("ws")) return url;
        } catch { }
        const u = new URL(window.location.href);
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        u.pathname = "/ws/subtitles";           // << HERE
        u.search = "";
        u.hash = "";
        return u.toString();
    }, [url]);


    useEffect(() => {
        stopFlag.current = false;

        function scheduleReconnect() {
            if (stopFlag.current) return;
            // exponential-ish w/ jitter (max ~8s)
            backoff.current = Math.min(backoff.current * 2 || 500, 8000);
            const jitter = 0.25 + Math.random() * 0.75;
            const ms = Math.round(backoff.current * jitter);
            setTimeout(() => connect(), ms);
        }

        function connect() {
            if (stopFlag.current) return;
            try {
                const ws = new WebSocket(resolvedUrl);
                wsRef.current = ws;

                ws.onopen = () => {
                    setConnected(true);
                    backoff.current = 0; // reset backoff
                };

                ws.onclose = () => {
                    setConnected(false);
                    wsRef.current = null;
                    scheduleReconnect();
                };

                ws.onerror = () => {
                    // onerror will be followed by close; no-op here
                };

                ws.onmessage = (e) => {
                    try {
                        const msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data)) as unknown;

                        if (!msg || typeof msg !== "object" || typeof (msg as any).type !== "string") return;

                        switch ((msg as any).type) {
                            case "interim_kr": {
                                const t = (msg as { type: "interim_kr"; text: string }).text || "";
                                pendingInterim.current = t;
                                // ... rest unchanged
                                break;
                            }
                            case "final_kr": {
                                const t = (msg as { type: "final_kr"; text: string }).text?.trim() || "";
                                setKrFinal(t);
                                setKrInterim("");
                                break;
                            }
                            case "fast_final": {
                                const t = (msg as { type: "fast_final"; en: string }).en?.trim() || "";
                                if (t) setEnFinal(t);
                                break;
                            }
                            default:
                                // ignore unknown
                                break;
                        }
                    } catch {
                        // ignore non-JSON
                    }
                };

            } catch {
                scheduleReconnect();
            }
        }

        connect();

        return () => {
            stopFlag.current = true;
            if (rafId.current) cancelAnimationFrame(rafId.current);
            try {
                wsRef.current?.close();
            } catch { }
            wsRef.current = null;
        };
    }, [resolvedUrl]);

    return { connected, krInterim, krFinal, enFinal };
}
