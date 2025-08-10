// utils/useTranslationSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";
import { WS_URL } from "./urls";

type Meta = {
  translated?: string;
  mode?: "pre" | "realtime";
  match_score?: number;
  matched_source?: string | null;
  partial?: boolean;
  segment_id?: string | number;
  rev?: number;
};

type ServerBroadcast = {
  type: "translation";
  payload: string;
  lang: string;
  meta?: Meta;
};

type ServerReply = {
  translated: string;
  mode: "pre" | "realtime";
  match_score: number;
  matched_source?: string | null;
  original?: string;
  method?: string;
};

type LastState = {
  text: string;          // last committed text
  lang: string;
  mode: "pre" | "realtime";
  matchScore: number;
  matchedSource: string | null;
  preview?: string;      // latest preview (partial) text
  segmentId?: string | number;
  rev?: number;
};

export function useTranslationSocket({ isProducer = false }: { isProducer?: boolean } = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<LastState>({
    text: "",
    lang: "en",
    mode: "realtime",
    matchScore: 0,
    matchedSource: null,
  });

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (evt: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(evt.data) as unknown;

        // Broadcast from server: { type: "translation", payload, lang, meta? }
        if (
          raw &&
          typeof raw === "object" &&
          "type" in raw &&
          (raw as any).type === "translation"
        ) {
          const b = raw as ServerBroadcast;
          const meta = b.meta ?? {};
          const isPartial = !!meta.partial;
          const segId = meta.segment_id;
          const rev = typeof meta.rev === "number" ? meta.rev : 0;

          if (isPartial) {
            setLast(prev => ({
              ...prev,
              preview: b.payload ?? meta.translated ?? "",
              segmentId: segId,
              rev,
            }));
          } else {
            setLast({
              text: b.payload ?? meta.translated ?? "",
              lang: b.lang ?? "en",
              mode: (meta.mode as "pre" | "realtime") ?? "realtime",
              matchScore: typeof meta.match_score === "number" ? meta.match_score : 0,
              matchedSource: (meta.matched_source as string) ?? null,
              preview: undefined,
              segmentId: segId,
              rev,
            });
          }
          return;
        }

        // Direct reply shape from server: { translated, mode, ... }
        if (raw && typeof raw === "object" && "translated" in raw) {
          const r = raw as ServerReply;
          setLast({
            text: r.translated,
            lang: "en",
            mode: r.mode,
            matchScore: r.match_score,
            matchedSource: r.matched_source ?? null,
          });
          return;
        }

        // ignore everything else
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      try { ws.close(); } catch { /* noop */ }
    };
  }, []);

  const sendProducerText = useCallback((
    text: string,
    source_lang: string = "ko",
    target_lang: string = "en",
    partial: boolean = false,
    segment_id?: number | string,
    rev?: number
  ) => {
    if (!isProducer) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text, source_lang, target_lang, partial, segment_id, rev }));
    }
  }, [isProducer]);

  return { connected, last, sendProducerText };
}
