// frontend/pages/live.tsx
import { useEffect, useRef, useState } from 'react';
import { startMicStream } from '../lib/useMicTranslate';

const API = process.env.NEXT_PUBLIC_API_BASE_URL!;
const WS = process.env.NEXT_PUBLIC_WS_URL!;

export default function Live() {
  const [krInterim, setKrInterim] = useState('');
  const [krFinal, setKrFinal] = useState('');
  const [en, setEn] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'stopped' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string>('');
  const [micRms, setMicRms] = useState<number>(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctlRef = useRef<ReturnType<typeof startMicStream> | null>(null);

  // create controller once
  // pages/live.tsx
  useEffect(() => {
    ctlRef.current = startMicStream(
      WS,
      async (m) => {
        if (m.type === 'interim_kr') setKrInterim(m.text);
        if (m.type === 'final_kr') setKrFinal(m.text);
        if (m.type === 'fast_final') {
          setEn(m.en);
          try {
            const res = await fetch(`${API}/api/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: m.en, voice: 'en-US-Wavenet-D' }),
            });
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = audioRef.current!;
            a.src = url;
            await a.play().catch(() => { });
          } catch (e) { console.error(e); }
        }
      },
      // optional: mic level UI (will only fire if worker posts {rms})
      (rms) => setMicRms(rms)
    );

    return () => { ctlRef.current?.stop(); ctlRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const testEchoUrl = process.env.NEXT_PUBLIC_WS_URL!.replace('/ws/translate', '/ws/echo-bytes');
  ctlRef.current = startMicStream(testEchoUrl, (m) => {
    // the echo endpoint occasionally sends {"echo_bytes_total": N}
    if ((m as any).echo_bytes_total) {
      console.log('echo total bytes from server:', (m as any).echo_bytes_total);
    }
  });

  const onStart = async () => {
    try {
      setErrMsg('');
      setStatus('running');
      if (!ctlRef.current?.start) {
        throw new Error('Mic controller not ready. (start is not a function)');
      }
      await ctlRef.current.start();
    } catch (e: any) {
      setStatus('error');
      setErrMsg(e?.message ?? 'Could not start microphone/stream.');
      console.error(e);
    }
  };

  const onStop = async () => {
    try {
      await ctlRef.current?.stop?.();
      setStatus('stopped');
    } catch {
      // ignore
    }
  };

  // mic level width (0–1 -> 0–100%)
  const micPct = Math.max(0, Math.min(1, micRms)) * 100;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">
            Live Worship Translation (Google STT → Translate → TTS)
          </h1>
          <div className="flex gap-2">
            <button
              onClick={onStart}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-white shadow hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50"
              disabled={status === 'running'}
            >
              Start
            </button>
            <button
              onClick={onStop}
              className="rounded-xl bg-gray-200 px-4 py-2 text-gray-900 shadow hover:bg-gray-300 active:bg-gray-400"
            >
              Stop
            </button>
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
          {/* Left: Korean */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Korean (interim)</div>
              <div className="min-h-16 whitespace-pre-wrap text-gray-900">
                {krInterim || <span className="text-gray-400">—</span>}
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Korean (final)</div>
              <div className="min-h-16 whitespace-pre-wrap font-medium text-gray-900">
                {krFinal || <span className="text-gray-400">—</span>}
              </div>
            </section>
          </div>

          {/* Right: English */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">English (fast final)</div>
              <div className="min-h-24 whitespace-pre-wrap text-lg font-semibold text-gray-900">
                {en || <span className="text-gray-400">—</span>}
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Audio Preview</div>
              <audio ref={audioRef} controls className="w-full" />
            </section>
          </div>
        </div>

        {/* Footer note */}
        <p className="mt-8 text-xs text-gray-500">
          Using <span className="font-medium">Speech-to-Text v2 (global recognizer)</span>,{' '}
          <span className="font-medium">Cloud Translation v3</span>, and{' '}
          <span className="font-medium">Cloud Text-to-Speech</span>.
        </p>
      </div>
    </div>
  );
}
