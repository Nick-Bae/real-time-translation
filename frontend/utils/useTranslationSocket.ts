// frontend/utils/useTranslationSocket.ts
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { WS_URL } from './urls';
import { d } from './debug';

type Meta = {
  translated?: string;
  mode?: 'pre' | 'realtime';
  match_score?: number;
  matched_source?: string | null;
  partial?: boolean;
  segment_id?: string | number;
  rev?: number;
};

type ServerBroadcast = {
  type: 'translation';
  payload: string;
  lang: string;
  meta?: Meta;
};

type ServerReply = {
  translated: string;
  mode: 'pre' | 'realtime';
  match_score: number;
  matched_source?: string | null;
  original?: string;
  method?: string;
};

export type LastState = {
  text: string;          // last committed translated text
  lang: string;
  mode: 'pre' | 'realtime';
  matchScore: number;
  matchedSource: string | null;
  preview?: string;      // latest preview/partial
  segmentId?: string | number;
  rev?: number;
};

export function useTranslationSocket({ isProducer = false }: { isProducer?: boolean } = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<LastState>({
    text: '',
    lang: 'en',
    mode: 'realtime',
    matchScore: 0,
    matchedSource: null,
  });

  // simple reconnect-with-backoff
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const connect = () => {
      if (!aliveRef.current) return;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      try { wsRef.current?.close(); } catch { }
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      d('ws', 'connecting ' + WS_URL);
      setConnected(false);

      ws.onopen = () => {
        d('ws', 'open');
        setConnected(true);
        retryRef.current = 0;
        if (!isProducer) {
          // optional: let server know this is a consumer
          try { ws.send(JSON.stringify({ type: 'consumer_join' })); } catch { }
        }
      };

      ws.onclose = () => {
        d('ws', 'closed');
        setConnected(false);
        if (!aliveRef.current) return;
        const delay = Math.min(30000, 1000 * Math.pow(2, retryRef.current++));
        d('ws', `reconnect in ${delay}ms`);
        retryTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (e) => {
        d('ws', 'error', e);
      };

      ws.onmessage = (evt: MessageEvent) => {
        try {
          const raw = JSON.parse(evt.data as string);

          // { type: "translation", payload, lang, meta? }
          if (raw && typeof raw === 'object' && raw.type === 'translation') {
            const b = raw as ServerBroadcast;
            const meta = b.meta ?? {};
            const isPartial = !!meta.partial;
            const segId = meta.segment_id;
            const rev = typeof meta.rev === 'number' ? meta.rev : 0;

            if (isPartial) {
              setLast((prev) => ({
                ...prev,
                preview: b.payload ?? meta.translated ?? '',
                segmentId: segId,
                rev,
              }));
            } else {
              setLast({
                text: b.payload ?? meta.translated ?? '',
                lang: b.lang ?? 'en',
                mode: (meta.mode as 'pre' | 'realtime') ?? 'realtime',
                matchScore: typeof meta.match_score === 'number' ? meta.match_score : 0,
                matchedSource: (meta.matched_source as string) ?? null,
                preview: undefined,
                segmentId: segId,
                rev,
              });
            }
            return;
          }

          // { translated, mode, ... }
          if (raw && typeof raw === 'object' && 'translated' in raw) {
            const r = raw as ServerReply;
            setLast({
              text: r.translated,
              lang: 'en',
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
    };

    connect();

    return () => {
      aliveRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      try { wsRef.current?.close(); } catch { }
    };
  }, [isProducer]);

  // 👇 Producer send helper
  const sendProducerText = useCallback(
    (text: string, source: string, target: string, isPartial: boolean, id?: number, rev?: number, finalFlag?: boolean) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const payload = isPartial
        ? { type: 'producer_partial', text, source, target }
        : { type: 'producer_commit', text, source, target, id, rev, final: !!finalFlag };

      try { d('ws->', JSON.stringify(payload)); } catch { }
      ws.send(JSON.stringify(payload));
    },
    []
  );

  // ✅ Always return the same shape
  return { connected, last, sendProducerText };
}
