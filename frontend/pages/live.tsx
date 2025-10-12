// frontend/pages/live.tsx
"use client";

import { useRef, useState } from "react";
import { startMicStream } from "../lib/useMicTranslate";
import { useAudioQueue } from "../lib/useAudioQueue";

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

const API = process.env.NEXT_PUBLIC_API_BASE_URL!;
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL!;

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
  const seqRef = useRef<number>(1);
  const lastCommitAtRef = useRef<number>(0);

  const COMMIT_GRACE_MS = 3000; // use this consistent window
  const recentKoCommitsRef = useRef<Map<string, number>>(new Map());
  const recentEnPlayedRef = useRef<Map<string, number>>(new Map());
  // Keep one EN per KO clause (within a short window)
  const enByKoRef = useRef<Map<string, { en: string; spoken: boolean; ts: number }>>(new Map());
  const lastKoKeyRef = useRef<string | null>(null);
  const spokenSeqsRef = useRef<Set<number>>(new Set());

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

      await ctlRef.current?.stop?.().catch(() => { });
      ctlRef.current = null;

      const wsUrl = buildWsUrl();

      const ctl = startMicStream(
        wsUrl,
        async (m: any) => {
          console.log("[WS IN]", m.type, m);
          if (m.type === "interim_kr") setKrInterim(m.text);
          if (m.type === "final_kr") setKrFinal(m.text);

          // Prevent fast_final from stomping on a fresh commit
          if (m.type === "fast_final") {
            const ff = m as FastFinalMsg;

            // normalize
            const en = (ff.en || "").replace(/\s+/g, " ").trim();
            if (!en) return;

            const seq = typeof ff.seq === "number" ? ff.seq : undefined;
            const now = Date.now();

            // Always update UI (treat as preview/refinement in the last line)
            setEn(en);
            setSegments(prev => {
              if (!prev.length) return [en];
              const copy = prev.slice();
              copy[copy.length - 1] = en;
              return copy;
            });

            // If we already spoke this seq, bail
            if (seq && spokenSeqsRef.current.has(seq)) return;

            // Keep KO->EN cache small and current
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

            // If a commit was just sent, treat fast_final as preview only (no TTS).
            // This avoids a double play when the commit TTS lands a moment later.
            if (now - lastCommitAtRef.current < COMMIT_GRACE_MS && lastKoKeyRef.current) {
              return;
            }

            // Otherwise, speak the fast_final (this is the "no early commit" case).
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

                // Mark spoken for this KO key too (prevents re-speaking on a later commit of same clause)
                if (lastKoKeyRef.current) {
                  enByKoRef.current.set(lastKoKeyRef.current, { en, spoken: true, ts: now });
                }
              }
            } catch (err) {
              console.error(err);
            }
          }

          // Server-driven clause commit → client translate + TTS
          if (m.type === "commit") {
            try {
              console.log("[COMMIT] raw:", m);

              lastCommitAtRef.current = Date.now();

              // 1) Normalize KO, compute stable KO key, remember it for fast_final merges
              const koClauseRaw = typeof m.payload === "string" ? m.payload : "";
              const koClause = normKo(koClauseRaw);
              if (!koClause) return;

              if (seenRecently(recentKoCommitsRef.current, koClause, DEDUP_WINDOW_MS)) {
                console.log("[COMMIT] dedup KO (skip)", koClause);
                return;
              }

              const key = koKey(koClause);
              lastKoKeyRef.current = key;
              purgeOldKo(enByKoRef.current);

              const srcCode = LANGS[srcIdx].tr; // "ko"
              const dstCode = LANGS[dstIdx].tr; // "en"

              // 2) Translate
              const trRes = await fetch(`${API}/api/translate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: koClause, src: srcCode, dst: dstCode }),
              });
              if (!trRes.ok) {
                const eTxt = await trRes.text().catch(() => "");
                console.error("[COMMIT] translate failed:", trRes.status, eTxt);
                return;
              }
              const trJson = await trRes.json().catch(() => ({} as any));
              const enText =
                (typeof trJson?.text === "string" && trJson.text) ||
                (typeof trJson?.translated === "string" && trJson.translated) ||
                (typeof trJson?.en === "string" && trJson.en) ||
                "";
              const enNorm = normEn(enText);
              if (!enNorm) {
                console.warn("[COMMIT] empty EN");
                return;
              }

              // 3) Coalesce by KO key: replace last UI line if we already showed a preview/older EN
              const existing = enByKoRef.current.get(key);
              setEn(enNorm);
              setSegments((prev) => {
                if (!prev.length) return [enNorm];
                if (existing) {
                  // last segment belongs to this KO (fast_final preview or earlier commit): replace it
                  const copy = prev.slice();
                  copy[copy.length - 1] = enNorm;
                  return copy;
                }
                // if identical to last, keep list stable
                if (normEn(prev[prev.length - 1]) === enNorm) return prev;
                return [...prev, enNorm];
              });

              // 4) Speak once per KO key (commit path is authoritative)
              let speak = !existing?.spoken;

              // keep your “recent EN spoken” dedup as an extra guard
              if (speak && seenRecently(recentEnPlayedRef.current, enNorm, DEDUP_WINDOW_MS)) {
                console.log("[COMMIT] dedup EN (skip TTS)", enNorm);
                speak = false;
              }

              if (speak) {
                const ttsRes = await fetch(`${API}/api/tts`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text: enNorm,
                    voice: VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
                  }),
                });

                if (ttsRes.ok) {
                  const ab = await ttsRes.arrayBuffer();
                  if (ab.byteLength > 0) {
                    enqueue({ arrayBuffer: ab });
                    enByKoRef.current.set(key, { en: enNorm, spoken: true, ts: Date.now() });
                  } else {
                    enByKoRef.current.set(key, { en: enNorm, spoken: false, ts: Date.now() });
                  }
                } else {
                  console.warn("[COMMIT] TTS failed", ttsRes.status);
                  enByKoRef.current.set(key, { en: enNorm, spoken: false, ts: Date.now() });
                }
              } else {
                // Already spoken (or dedupbed): just update cache with latest text/time
                enByKoRef.current.set(key, { en: enNorm, spoken: true, ts: Date.now() });
              }
            } catch (e) {
              console.error("[COMMIT] error:", e);
            }
          }
          // Optional: if backend sends already-translated chunks
          if (m.type === "translation") {
            const enText = String(m.payload || "");
            setEn(enText);
            setSegments((prev) => [...prev, enText]);
            try {
              const res = await fetch(`${API}/api/tts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text: enText,
                  voice:
                    VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
                }),
              });
              if (!res.ok)
                throw new Error(`TTS ${res.status} ${res.statusText}`);
              const blob = await res.blob();
              enqueue({ blob });
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
