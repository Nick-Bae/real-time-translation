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
  seq?: number;   // ← optional
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

// Backing REST + WS bases from your env (unchanged)
const API = process.env.NEXT_PUBLIC_API_BASE_URL!;
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL!; // should already be .../ws/translate

export default function Live() {
  // UI state
  const [srcIdx, setSrcIdx] = useState<number>(0); // default Korean
  const [dstIdx, setDstIdx] = useState<number>(1); // default English

  // stream state
  const [krInterim, setKrInterim] = useState("");
  const [krFinal, setKrFinal] = useState("");
  const [en, setEn] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "stopped" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [micRms, setMicRms] = useState<number>(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctlRef = useRef<ReturnType<typeof startMicStream> | null>(null);
  const { enqueue, clear } = useAudioQueue(audioRef);
  const seqRef = useRef<number>(1); // local sequence to preserve order

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  }

  // Build a WS URL with role + chosen languages + voice
  function buildWsUrl() {
    const src = LANGS[srcIdx];
    const dst = LANGS[dstIdx];
    const voice = VOICE_BY_TR[dst.tr] || "en-US-Wavenet-D";

    const u = new URL(WS_BASE);
    // IMPORTANT: backend expects role
    u.searchParams.set("role", "producer");
    u.searchParams.set("src", src.stt);    // STT language, e.g. "en-US"
    u.searchParams.set("dst", dst.tr);     // Translate target, e.g. "ko"
    u.searchParams.set("voice", voice);
    return u.toString();
  }

  async function onStart() {
    try {
      setErrMsg('');
      setStatus('running');

      await ctlRef.current?.stop?.().catch(() => { });
      ctlRef.current = null;

      const wsUrl = buildWsUrl();

      const ctl = startMicStream(
        wsUrl,
        async (m) => {
          if (m.type === 'interim_kr') setKrInterim(m.text);
          if (m.type === 'final_kr') setKrFinal(m.text);
          if (m.type === "fast_final") {
            const ff = m as FastFinalMsg; // narrow
            setEn(ff.en);

            try {
              const res = await fetch(`${API}/api/tts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text: ff.en,
                  voice: VOICE_BY_TR[LANGS[dstIdx].tr] || "en-US-Wavenet-D",
                }),
              });
              if (!res.ok) throw new Error(`TTS ${res.status} ${res.statusText}`);
              const blob = await res.blob();

              const backendSeq = typeof ff.seq === "number" ? ff.seq : undefined;
              enqueue({ blob, seq: backendSeq });
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
      setStatus('error');
      setErrMsg(errorMessage(err)); // ✅ properly narrowed
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
                <option value={i} key={l.stt}>{l.label} – {l.stt}</option>
              ))}
            </select>

            <label className="text-sm text-gray-600">Target (Translate)</label>
            <select
              className="rounded-md border px-2 py-1"
              value={dstIdx}
              onChange={(e) => setDstIdx(Number(e.target.value))}
            >
              {LANGS.map((l, i) => (
                <option value={i} key={l.tr}>{l.label} – {l.tr}</option>
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
              {/* Optional: emergency flush button */}
              <button
                onClick={() => clear()}
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
                Target (fast final)
              </div>
              <div className="min-h-24 whitespace-pre-wrap text-lg font-semibold text-gray-900">
                {en || <span className="text-gray-400">—</span>}
              </div>
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
