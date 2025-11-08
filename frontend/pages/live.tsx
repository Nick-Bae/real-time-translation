// frontend/pages/live.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startMicStream } from "../lib/useMicTranslate";
import { useAudioQueue } from "../lib/useAudioQueue";
import { API_URL, WS_URL } from "../utils/urls";

type Lang = { label: string; stt: string; tr: string };
type FastFinalMsg = {
  type: "fast_final";
  en: string;
  from: "google";
  dst?: string;
  origin?: string;
  score?: number;
  seq?: number; // optional
};

const LANGS: Lang[] = [
  { label: "Korean", stt: "ko-KR", tr: "ko" },
  { label: "English", stt: "en-US", tr: "en" },
  { label: "Spanish", stt: "es-ES", tr: "es" },
  { label: "Japanese", stt: "ja-JP", tr: "ja" },
  { label: "Chinese (CMN)", stt: "cmn-Hans-CN", tr: "zh" },
];

const VOICE_BY_TR: Record<string, string> = {
  en: "en-US-Wavenet-D",
  es: "es-ES-Standard-A",
  ja: "ja-JP-Wavenet-A",
  ko: "ko-KR-Wavenet-A",
  zh: "cmn-CN-Wavenet-A",
};

const API = API_URL;
const WS_BASE = WS_URL;

// Toggle whether streaming clause previews (commit / fast_final / translation) should
// be shown/spoken before a sentence is finalized. Default: off for production polish.
const PREVIEW_TEXT_ENABLED =
  process.env.NEXT_PUBLIC_LIVE_PREVIEW_TEXT === "1";
const PREVIEW_AUDIO_ENABLED =
  process.env.NEXT_PUBLIC_LIVE_PREVIEW_AUDIO === "1";

export default function Live() {
  // UI state
  const [srcIdx, setSrcIdx] = useState<number>(0); // default Korean
  const [dstIdx, setDstIdx] = useState<number>(1); // default English

  // stream state
  const [krInterim, setKrInterim] = useState("");
  const [krFinal, setKrFinal] = useState("");
  const [en, setEn] = useState("");
  const [status, setStatus] =
    useState<"idle" | "running" | "stopped" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [micRms, setMicRms] = useState<number>(0);

  // (optional) show clause splits explicitly
  const [segments, setSegments] = useState<string[]>([]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctlRef = useRef<ReturnType<typeof startMicStream> | null>(null);
  const { enqueue, clear } = useAudioQueue(audioRef);
  const lastCommitAtRef = useRef<number>(0);

  const COMMIT_GRACE_MS = 3000; // use this consistent window
  const COMMIT_SPEAK_DELAY_MS = 600; // allow quick replacements before TTS fires
  const TRANSLATION_FALLBACK_DELAY_MS = 1500; // give commits a chance before speaking translation previews
  const recentEnPlayedRef = useRef<Map<string, number>>(new Map());
  // Keep one EN per KO clause (within a short window)
  const enByKoRef = useRef<Map<string, { en: string; spoken: boolean; ts: number }>>(new Map());
  const lastKoKeyRef = useRef<string | null>(null);
  const spokenSeqsRef = useRef<Set<number>>(new Set());
  const pendingCommitTimersRef = useRef<Map<string, number>>(new Map());

  const utteranceSegmentCountRef = useRef(0);
  const finalTranslateAbortRef = useRef<AbortController | null>(null);

  const KO_WINDOW_MS = 5000; // treat EN updates for the same KO within 5s as the same clause


  const DEDUP_WINDOW_MS = 4000; // ignore exact duplicates within 4s


  function normKo(s: string) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function normEn(s: string) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function seenRecently(map: Map<string, number>, key: string, windowMs: number) {
    const now = Date.now();
    // prune old entries (keep map small)
    for (const [k, t] of map) if (now - t > windowMs) map.delete(k);
    const hit = map.has(key) && (now - (map.get(key) || 0)) < windowMs;
    if (!hit) map.set(key, now);
    return hit;
  }
  function koKey(s: string) {
    // collapses whitespace → stable key for a KO clause
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function purgeOldKo(
    map: Map<string, { en: string; spoken: boolean; ts: number }>,
    windowMs = KO_WINDOW_MS
  ) {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.ts > windowMs) map.delete(k);
  }

  function clearPendingCommitTimer(key: string) {
    const pending = pendingCommitTimersRef.current.get(key);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      pendingCommitTimersRef.current.delete(key);
    }
  }

  function scheduleCommitSpeak(key: string, enText: string, delayMs = COMMIT_SPEAK_DELAY_MS) {
    clearPendingCommitTimer(key);
    const timerId = window.setTimeout(() => {
      pendingCommitTimersRef.current.delete(key);
      void (async () => {
        try {
          const ttsRes = await fetch(`${API}/api/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: enText,
              voice: VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
            }),
          });
          if (!ttsRes.ok) throw new Error(`TTS ${ttsRes.status} ${ttsRes.statusText}`);
          const ab = await ttsRes.arrayBuffer();
          if (ab.byteLength > 0) {
            enqueue({ arrayBuffer: ab });
          }
          const stamp = Date.now();
          for (const [k, t] of recentEnPlayedRef.current) {
            if (stamp - t > DEDUP_WINDOW_MS) recentEnPlayedRef.current.delete(k);
          }
          recentEnPlayedRef.current.set(enText, stamp);
          enByKoRef.current.set(key, { en: enText, spoken: true, ts: Date.now() });
        } catch (err) {
          console.error("[COMMIT] TTS error", err);
          enByKoRef.current.set(key, { en: enText, spoken: false, ts: Date.now() });
        }
      })();
    }, delayMs);
    pendingCommitTimersRef.current.set(key, timerId);
  }

  type SpeakOutcome = "played" | "duplicate" | "failed";

  async function speakClauseNow(enText: string): Promise<SpeakOutcome> {
    const normalized = normEn(enText);
    if (!normalized) return "failed";

    const now = Date.now();
    for (const [k, t] of recentEnPlayedRef.current) {
      if (now - t > DEDUP_WINDOW_MS) recentEnPlayedRef.current.delete(k);
    }
    const last = recentEnPlayedRef.current.get(normalized);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
      return "duplicate";
    }

    try {
      const voice = VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D";
      const res = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: normalized, voice }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status} ${res.statusText}`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 0) {
        enqueue({ arrayBuffer: ab });
        recentEnPlayedRef.current.set(normalized, Date.now());
        return "played";
      }
    } catch (err) {
      console.error("[TTS] speakClause error", err);
    }
    return "failed";
  }

  useEffect(() => {
    return () => {
      pendingCommitTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      pendingCommitTimersRef.current.clear();
      if (finalTranslateAbortRef.current) {
        finalTranslateAbortRef.current.abort();
        finalTranslateAbortRef.current = null;
      }
    };
  }, []);

  const translateFinalKo = useCallback(
    async (fullKo: string) => {
      const normalized = normKo(fullKo);
      if (!normalized) return;
      const key = koKey(normalized);

      const existing = enByKoRef.current.get(key);
      const existingEn = existing?.en ? normEn(existing.en) : "";
      if (existingEn) {
        setEn(existingEn);
        setSegments((prev) => {
          if (!prev.length) {
            return [existingEn];
          }
          const total = prev.length;
          const activeCount = Math.min(
            Math.max(utteranceSegmentCountRef.current, 0),
            total
          );
          const replaceCount = activeCount > 0 ? activeCount : 0;
          const base =
            replaceCount > 0 ? prev.slice(0, total - replaceCount) : prev.slice();
          if (base.length && normEn(base[base.length - 1]) === existingEn) {
            return base;
          }
          return [...base, existingEn];
        });
        utteranceSegmentCountRef.current = 0;
        const alreadySpoken = existing?.spoken ?? false;
        if (!alreadySpoken) {
          const outcome = await speakClauseNow(existingEn);
          const stamp = Date.now();
          enByKoRef.current.set(key, {
            en: existingEn,
            spoken: outcome !== "failed",
            ts: stamp,
          });
        } else {
          enByKoRef.current.set(key, {
            en: existingEn,
            spoken: true,
            ts: Date.now(),
          });
        }
        lastKoKeyRef.current = key;
        return;
      }

      if (finalTranslateAbortRef.current) {
        finalTranslateAbortRef.current.abort();
      }
      const controller = new AbortController();
      finalTranslateAbortRef.current = controller;
      try {
        const res = await fetch(`${API}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: normalized,
            src: LANGS[srcIdx].tr,
            dst: LANGS[dstIdx].tr,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`translate ${res.status} ${res.statusText}`);
        const json = await res.json().catch(() => ({} as any));
        const finalEnRaw =
          (typeof json?.text === "string" && json.text) ||
          (typeof json?.translated === "string" && json.translated) ||
          (typeof json?.en === "string" && json.en) ||
          "";
        const finalEn = normEn(finalEnRaw);
        if (!finalEn) return;

        setEn(finalEn);
        setSegments((prev) => {
          if (!prev.length) {
            return [finalEn];
          }
          const total = prev.length;
          const activeCount = Math.min(
            Math.max(utteranceSegmentCountRef.current, 0),
            total
          );
          const replaceCount = activeCount > 0 ? activeCount : 0;
          const base =
            replaceCount > 0 ? prev.slice(0, total - replaceCount) : prev.slice();
          if (base.length && normEn(base[base.length - 1]) === finalEn) {
            return base;
          }
          return [...base, finalEn];
        });
        utteranceSegmentCountRef.current = 0;
        const outcome = await speakClauseNow(finalEn);
        const timestamp = Date.now();
        enByKoRef.current.set(key, {
          en: finalEn,
          spoken: outcome !== "failed",
          ts: timestamp,
        });
        lastKoKeyRef.current = key;
      } catch (err) {
        if ((err as any)?.name === "AbortError") return;
        console.error("[final_kr translate]", err);
      } finally {
        if (finalTranslateAbortRef.current === controller) {
          finalTranslateAbortRef.current = null;
        }
      }
    },
    [API, dstIdx, srcIdx]
  );

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }

  function buildWsUrl() {
    const src = LANGS[srcIdx];
    const dst = LANGS[dstIdx];
    const voice = VOICE_BY_TR[dst.tr] || "en-US-Wavenet-D";

    const u = new URL(WS_BASE);
    u.searchParams.set("role", "producer");
    u.searchParams.set("src", src.stt);
    u.searchParams.set("dst", dst.tr);
    u.searchParams.set("voice", voice);
    return u.toString();
  }

  async function onStart() {
    try {
      setErrMsg("");
      setStatus("running");
      setSegments([]);
      setEn("");
      setKrInterim("");
      setKrFinal("");
      utteranceSegmentCountRef.current = 0;
      if (finalTranslateAbortRef.current) {
        finalTranslateAbortRef.current.abort();
        finalTranslateAbortRef.current = null;
      }
      lastKoKeyRef.current = null;

      await ctlRef.current?.stop?.().catch(() => { });
      ctlRef.current = null;

      const wsUrl = buildWsUrl();

      const ctl = startMicStream(
        wsUrl,
        async (m: any) => {
          console.log("[WS IN]", m.type, m);
          if (m.type === "idle_timeout") {
            const secs = typeof m.seconds === "number" ? m.seconds : undefined;
            console.log("[WS] idle_timeout received", m);
            await ctlRef.current?.stop?.().catch(() => {});
            setStatus("stopped");
            setErrMsg(
              secs
                ? `Session closed after ${secs.toFixed(0)}s of silence.`
                : "Session closed due to inactivity."
            );
            return;
          }
          if (m.type === "interim_kr") setKrInterim(m.text);
          if (m.type === "final_kr") {
            const tailKo = normKo((m as any).text || "");
            setKrFinal(tailKo);

            void translateFinalKo(tailKo);
          }

          // Prevent fast_final from stomping on a fresh commit
          if (m.type === "fast_final") {
            const ff = m as FastFinalMsg;

            const en = (ff.en || "").replace(/\s+/g, " ").trim();
            if (!en) return;

            const seq = typeof ff.seq === "number" ? ff.seq : undefined;
            const now = Date.now();

            if (lastKoKeyRef.current) {
              for (const [k, v] of enByKoRef.current) {
                if (now - v.ts > KO_WINDOW_MS) enByKoRef.current.delete(k);
              }
              const prev = enByKoRef.current.get(lastKoKeyRef.current);
              enByKoRef.current.set(lastKoKeyRef.current, {
                en,
                spoken: prev?.spoken ?? false,
                ts: now,
              });
            }

            if (!PREVIEW_TEXT_ENABLED && !PREVIEW_AUDIO_ENABLED) {
              return;
            }

            if (PREVIEW_TEXT_ENABLED) {
              setEn(en);
              setSegments((prev) => {
                if (utteranceSegmentCountRef.current === 0) {
                  utteranceSegmentCountRef.current = 1;
                  return [...prev, en];
                }
                if (!prev.length) {
                  utteranceSegmentCountRef.current = 1;
                  return [en];
                }
                const copy = prev.slice();
                copy[copy.length - 1] = en;
                return copy;
              });
            }

            if (
              PREVIEW_AUDIO_ENABLED &&
              !(now - lastCommitAtRef.current < COMMIT_GRACE_MS && lastKoKeyRef.current)
            ) {
              if (seq && spokenSeqsRef.current.has(seq)) {
                return;
              }

              try {
                const res = await fetch(`${API}/api/tts`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text: en,
                    voice: VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
                  }),
                });
                if (!res.ok) throw new Error(`TTS ${res.status} ${res.statusText}`);

                const ab = await res.arrayBuffer();
                if (ab.byteLength > 0) {
                  enqueue({ arrayBuffer: ab, seq });
                  if (seq) spokenSeqsRef.current.add(seq);
                  if (lastKoKeyRef.current) {
                    enByKoRef.current.set(lastKoKeyRef.current, { en, spoken: true, ts: Date.now() });
                  }
                }
              } catch (err) {
                console.error(err);
              }
            }
          }

          // Server-driven clause commit → client translate + TTS
          if (m.type === "commit") {
            try {
              console.log("[COMMIT] raw:", m);

              // --- timing guard: ignore stale commits
              const tsMs = typeof (m as any).ts_ms === "number" ? (m as any).ts_ms : Date.now();
              if (tsMs < (lastCommitAtRef.current || 0)) {
                console.log("[COMMIT] stale (ts)", tsMs, "<", lastCommitAtRef.current);
                return;
              }
              lastCommitAtRef.current = tsMs;

              // --- normalize KO
              const rawKo = typeof (m as any).payload === "string" ? (m as any).payload : "";
              const koClause = normKo(rawKo);
              if (!koClause) return;
              if (PREVIEW_TEXT_ENABLED) {
                setKrFinal(koClause);
              }

              // --- stable key & caches
              const isReplace = !!(m as any).replace;
              const prevKey = lastKoKeyRef.current;
              const nextKey = koKey(koClause);
              let key = nextKey;
              let existingEntry = enByKoRef.current.get(nextKey);
              if (isReplace && prevKey) {
                if (prevKey !== nextKey) {
                  clearPendingCommitTimer(prevKey);
                  const carried = enByKoRef.current.get(prevKey);
                  if (carried) {
                    existingEntry = carried;
                    enByKoRef.current.delete(prevKey);
                  }
                } else {
                  existingEntry = enByKoRef.current.get(prevKey);
                }
              }
              lastKoKeyRef.current = nextKey;
              key = nextKey;
              purgeOldKo(enByKoRef.current);
              clearPendingCommitTimer(key);

              // --- get EN: prefer server-provided; else translate here
              let enText = "";
              if (typeof (m as any).en === "string" && (m as any).en.trim()) {
                enText = (m as any).en;
              } else {
                const srcCode = LANGS[srcIdx].tr; // "ko"
                const dstCode = LANGS[dstIdx].tr; // "en"
                const trRes = await fetch(`${API}/api/translate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: koClause, src: srcCode, dst: dstCode }),
                });
                if (!trRes.ok) {
                  console.warn("[COMMIT] translate failed", trRes.status);
                  return;
                }
                const trJson = await trRes.json().catch(() => ({} as any));
                enText =
                  (typeof trJson?.text === "string" && trJson.text) ||
                  (typeof trJson?.translated === "string" && trJson.translated) ||
                  (typeof trJson?.en === "string" && trJson.en) ||
                  "";
              }
              const enNorm = normEn(enText);
              if (!enNorm) return;

              // --- replace vs append
              if (PREVIEW_TEXT_ENABLED) {
                setEn(enNorm);
                setSegments((prev) => {
                  if (!prev.length) {
                    utteranceSegmentCountRef.current = 1;
                    return [enNorm];
                  }
                  if (isReplace || existingEntry) {
                    if (utteranceSegmentCountRef.current === 0) {
                      utteranceSegmentCountRef.current = 1;
                    }
                    const copy = prev.slice();
                    copy[copy.length - 1] = enNorm; // refine/replace
                    return copy;
                  }
                  if (utteranceSegmentCountRef.current === 0) {
                    utteranceSegmentCountRef.current = 1;
                    return [...prev, enNorm];
                  }
                  if (normEn(prev[prev.length - 1]) === enNorm) {
                    return prev; // exact duplicate
                  }
                  utteranceSegmentCountRef.current += 1;
                  return [...prev, enNorm]; // new clause
                });
              }

              const nowTs = Date.now();
              for (const [text, ts] of recentEnPlayedRef.current) {
                if (nowTs - ts > DEDUP_WINDOW_MS) {
                  recentEnPlayedRef.current.delete(text);
                }
              }
              const prevEn = existingEntry?.en ? normEn(existingEntry.en) : "";
              const enChanged = prevEn !== enNorm;
              const wasSpoken = existingEntry?.spoken ?? false;

              let shouldSpeak = enChanged || !wasSpoken;
              const lastSpokenAt = recentEnPlayedRef.current.get(enNorm);
              if (
                shouldSpeak &&
                lastSpokenAt !== undefined &&
                nowTs - lastSpokenAt < DEDUP_WINDOW_MS
              ) {
                console.log("[COMMIT] dedup EN (skip TTS window)", enNorm);
                shouldSpeak = false;
              }

              const previewWillSpeak = PREVIEW_AUDIO_ENABLED && shouldSpeak;
              const nextSpokenState = previewWillSpeak
                ? false
                : enChanged
                ? false
                : wasSpoken;

              enByKoRef.current.set(key, {
                en: enNorm,
                spoken: nextSpokenState,
                ts: nowTs,
              });

              if (previewWillSpeak) {
                scheduleCommitSpeak(key, enNorm);
              } else {
                clearPendingCommitTimer(key);
              }
            } catch (e) {
              console.error("[COMMIT] error:", e);
            }
          }

          // Optional: if backend sends already-translated chunks
          if (m.type === "translation") {
            const rawPayload =
              typeof (m as any)?.payload === "string"
                ? (m as any).payload
                : String((m as any)?.payload ?? "");
            const enNorm = normEn(rawPayload);
            if (!enNorm) return;

            const rawMetaKo =
              typeof (m as any)?.meta?.original === "string"
                ? (m as any).meta.original
                : "";
            const normMetaKo = normKo(rawMetaKo);
            const key = normMetaKo ? koKey(normMetaKo) : null;
            const now = Date.now();
            purgeOldKo(enByKoRef.current);

            for (const [k, t] of recentEnPlayedRef.current) {
              if (now - t > DEDUP_WINDOW_MS) recentEnPlayedRef.current.delete(k);
            }
            const lastPlayed = recentEnPlayedRef.current.get(enNorm);
            const isRecentDuplicate =
              lastPlayed !== undefined && now - lastPlayed < DEDUP_WINDOW_MS;
            const existing = key ? enByKoRef.current.get(key) : undefined;

            if (key) {
              enByKoRef.current.set(key, {
                en: enNorm,
                spoken: existing?.spoken ?? false,
                ts: now,
              });
            }

            if (!PREVIEW_TEXT_ENABLED && !PREVIEW_AUDIO_ENABLED) {
              return;
            }

            if (PREVIEW_TEXT_ENABLED) {
              setEn(enNorm);
              setSegments((prev) => {
                if (!prev.length) {
                  utteranceSegmentCountRef.current = 1;
                  return [enNorm];
                }
                if (existing) {
                  if (utteranceSegmentCountRef.current === 0) {
                    utteranceSegmentCountRef.current = 1;
                  }
                  const copy = prev.slice();
                  copy[copy.length - 1] = enNorm;
                  return copy;
                }
                if (utteranceSegmentCountRef.current === 0) {
                  utteranceSegmentCountRef.current = 1;
                  if (normEn(prev[prev.length - 1]) === enNorm) {
                    return prev;
                  }
                  return [...prev, enNorm];
                }
                const last = prev[prev.length - 1];
                if (normEn(last) === enNorm) return prev;
                utteranceSegmentCountRef.current += 1;
                return [...prev, enNorm];
              });
            }

            if (!PREVIEW_AUDIO_ENABLED) {
              return;
            }

            if (key) {
              const spoken = existing?.spoken ?? false;
              const hasPendingCommit = pendingCommitTimersRef.current.has(key);
              if (hasPendingCommit || spoken || isRecentDuplicate) return;

              scheduleCommitSpeak(key, enNorm, TRANSLATION_FALLBACK_DELAY_MS);
              return;
            }

            if (isRecentDuplicate) return;

            try {
              const res = await fetch(`${API}/api/tts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text: enNorm,
                  voice:
                    VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
                }),
              });
              if (!res.ok)
                throw new Error(`TTS ${res.status} ${res.statusText}`);
              const ab = await res.arrayBuffer();
              if (ab.byteLength > 0) {
                enqueue({ arrayBuffer: ab });
                const stamp = Date.now();
                for (const [k, t] of recentEnPlayedRef.current) {
                  if (stamp - t > DEDUP_WINDOW_MS) recentEnPlayedRef.current.delete(k);
                }
                recentEnPlayedRef.current.set(enNorm, stamp);
              }
            } catch (err) {
              console.error(err);
            }
          }
        },
        (rms) => setMicRms(rms)
      );

      ctlRef.current = ctl;
      await ctl.start();
    } catch (err: unknown) {
      setStatus("error");
      setErrMsg(errorMessage(err));
      console.error(err);
    }
  }

  async function onStop() {
    try {
      await ctlRef.current?.stop?.();
      setStatus("stopped");
    } catch { }
  }

  const micPct = Math.max(0, Math.min(1, micRms)) * 100;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">
            Live Worship Translation
          </h1>

          {/* Language selectors */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-gray-600">Source (STT)</label>
            <select
              className="rounded-md border px-2 py-1"
              value={srcIdx}
              onChange={(e) => setSrcIdx(Number(e.target.value))}
            >
              {LANGS.map((l, i) => (
                <option value={i} key={l.stt}>
                  {l.label} – {l.stt}
                </option>
              ))}
            </select>

            <label className="text-sm text-gray-600">Target (Translate)</label>
            <select
              className="rounded-md border px-2 py-1"
              value={dstIdx}
              onChange={(e) => setDstIdx(Number(e.target.value))}
            >
              {LANGS.map((l, i) => (
                <option value={i} key={l.tr}>
                  {l.label} – {l.tr}
                </option>
              ))}
            </select>

            <div className="flex gap-2">
              <button
                onClick={onStart}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-white shadow hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50"
                disabled={status === "running"}
              >
                Start
              </button>
              <button
                onClick={onStop}
                className="rounded-xl bg-gray-200 px-4 py-2 text-gray-900 shadow hover:bg-gray-300 active:bg-gray-400"
              >
                Stop
              </button>
              <button
                onClick={() => {
                  clear();
                  setSegments([]);
                  utteranceSegmentCountRef.current = 0;
                  if (finalTranslateAbortRef.current) {
                    finalTranslateAbortRef.current.abort();
                    finalTranslateAbortRef.current = null;
                  }
                  lastKoKeyRef.current = null;
                }}
                className="rounded-xl bg-gray-200 px-4 py-2 text-gray-900 shadow hover:bg-gray-300 active:bg-gray-400"
              >
                Flush Queue
              </button>
            </div>
          </div>
        </header>

        {/* Status / errors */}
        {errMsg && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
            {errMsg}
          </div>
        )}

        {/* Mic meter */}
        <div className="mb-6">
          <div className="mb-1 flex items-center justify-between text-sm text-gray-600">
            <span>Mic Level</span>
            <span className="tabular-nums">{micPct.toFixed(0)}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-emerald-600 transition-[width] duration-100"
              style={{ width: `${micPct}%` }}
            />
          </div>
        </div>

        {/* Panels */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left: Source language text */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Source (interim)
              </div>
              <div className="min-h-16 whitespace-pre-wrap text-gray-900">
                {krInterim || <span className="text-gray-400">—</span>}
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Source (final)
              </div>
              <div className="min-h-16 whitespace-pre-wrap font-medium text-gray-900">
                {krFinal || <span className="text-gray-400">—</span>}
              </div>
            </section>
          </div>

          {/* Right: Target language text + audio */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Target (clause / fast final)
              </div>
              <div className="min-h-24 whitespace-pre-wrap text-lg font-semibold text-gray-900">
                {en || <span className="text-gray-400">—</span>}
              </div>

              {/* Optional: render clause segments so you can *see* the split */}
              {segments.length > 0 && (
                <div className="mt-3 space-y-2">
                  {segments.map((s, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
                    >
                      {s}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Audio Preview
              </div>
              <audio ref={audioRef} controls className="w-full" />
            </section>
          </div>
        </div>

        <p className="mt-8 text-xs text-gray-500">
          Uses Google STT v2 • Cloud Translation v3 • Cloud TTS
        </p>
      </div>
    </div>
  );
}
