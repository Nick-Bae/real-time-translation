// components/ScriptUpload.tsx
"use client";
import { useMemo, useState } from "react";
import { API_URL } from "../utils/urls";

type DraftSegment = {
  id: number;
  ko: string;
  en: string;
};

const DEFAULT_THRESHOLD = 0.84;

const makeDefaultSermonId = () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export default function ScriptUpload() {
  const [sermonId, setSermonId] = useState<string>(makeDefaultSermonId());
  const [korean, setKorean] = useState<string>("");
  const [autoSplit, setAutoSplit] = useState<boolean>(true);
  const [threshold, setThreshold] = useState<number>(DEFAULT_THRESHOLD);
  const [segments, setSegments] = useState<DraftSegment[]>([]);
  const [status, setStatus] = useState<string>("");
  const [modelInfo, setModelInfo] = useState<string>("");

  const [draftLoading, setDraftLoading] = useState<boolean>(false);
  const [saveLoading, setSaveLoading] = useState<boolean>(false);
  const [testLoading, setTestLoading] = useState<boolean>(false);

  const [testInput, setTestInput] = useState<string>("");
  const [testResult, setTestResult] = useState<string>("");

  const trimmedSegments = useMemo(
    () =>
      segments.map((seg, idx) => ({
        id: idx + 1,
        ko: seg.ko.trim(),
        en: seg.en.trim(),
      })),
    [segments]
  );

  const updateSegment = (index: number, field: "ko" | "en", value: string) => {
    setSegments((prev) =>
      prev.map((seg, idx) => (idx === index ? { ...seg, [field]: value } : seg))
    );
  };

  const generateDraft = async () => {
    if (!sermonId.trim()) {
      setStatus("❌ Sermon ID is required.");
      return;
    }
    if (!korean.trim()) {
      setStatus("❌ Paste the Korean sermon draft first.");
      return;
    }
    setDraftLoading(true);
    setStatus("Generating draft via ChatGPT…");
    setModelInfo("");
    try {
      const res = await fetch(`${API_URL}/api/sermon/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sermon_id: sermonId.trim(),
          korean,
          auto_split: autoSplit,
          source_lang: "ko",
          target_lang: "en",
          threshold,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || res.statusText || "Draft generation failed");
      }

      const serverSegments: DraftSegment[] = Array.isArray(data?.segments)
        ? data.segments.map((seg: any, idx: number) => ({
            id: typeof seg?.id === "number" ? seg.id : idx + 1,
            ko: String(seg?.ko ?? "").trim(),
            en: String(seg?.en ?? "").trim(),
          }))
        : [];

      setSegments(serverSegments);
      const nextThreshold =
        typeof data?.threshold === "number" ? data.threshold : threshold;
      setThreshold(nextThreshold);
      const metaParts = [
        data?.translator === "openai_chatgpt" ? "ChatGPT" : data?.translator,
        data?.model ? `model: ${data.model}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      setModelInfo(metaParts);
      setStatus(`✅ Draft ready (${serverSegments.length} segments). Review and polish the English column.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`❌ ${msg}`);
    } finally {
      setDraftLoading(false);
    }
  };

  const saveFinal = async () => {
    if (!sermonId.trim()) {
      setStatus("❌ Sermon ID is required before saving.");
      return;
    }
    if (!trimmedSegments.length) {
      setStatus("❌ Generate a draft first.");
      return;
    }

    setSaveLoading(true);
    setStatus("Saving final script…");
    try {
      const payload = {
        sermon_id: sermonId.trim(),
        threshold,
        activate: true,
        segments: trimmedSegments,
      };
      const res = await fetch(`${API_URL}/api/sermon/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || res.statusText || "Save failed");
      }
      setStatus(
        `✅ Saved ${data?.stored ?? trimmedSegments.length} segments for ${data?.sermon_id || sermonId}. Threshold=${data?.threshold ?? threshold}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`❌ ${msg}`);
    } finally {
      setSaveLoading(false);
    }
  };

  const runTest = async () => {
    if (!testInput.trim()) {
      setTestResult("Type a Korean sentence to test.");
      return;
    }
    setTestLoading(true);
    setTestResult("Testing against prepared script…");
    try {
      const res = await fetch(`${API_URL}/api/sermon/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sermon_id: sermonId.trim() || undefined,
          text: testInput.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || res.statusText || "Test failed");
      }
      const matchLabel =
        typeof data?.score === "number"
          ? `score=${(data.score * 100).toFixed(1)}`
          : "no score";
      const mode = data?.translation ? "Prepared ✅" : "Fallback ⚠️";
      setTestResult(
        `${mode} · ${matchLabel}\nKO: ${(data?.matched || "—")}\nEN: ${data?.translation || "—"}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult(`❌ ${msg}`);
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ fontWeight: 600 }}>Sermon Preparation (ChatGPT-powered)</div>

      <div style={{ display: "grid", gap: 8 }}>
        <label>Sermon ID</label>
        <input
          type="text"
          value={sermonId}
          onChange={(e) => setSermonId(e.target.value)}
          placeholder="2025-11-02-am"
        />
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <label>Korean sermon draft</label>
        <textarea
          value={korean}
          onChange={(e) => setKorean(e.target.value)}
          rows={10}
          style={{ width: "100%" }}
          placeholder="Paste the full Korean sermon draft here…"
        />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={autoSplit}
            onChange={(e) => setAutoSplit(e.target.checked)}
          />
          Auto split by sentence
        </label>
        <label>
          Threshold:&nbsp;
          <input
            type="number"
            step="0.01"
            min={0}
            max={1}
            value={threshold}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!Number.isNaN(val)) {
                setThreshold(val);
              }
            }}
          />
        </label>
        <button onClick={generateDraft} disabled={draftLoading}>
          {draftLoading ? "Generating…" : "Generate draft"}
        </button>
      </div>

      {modelInfo && (
        <div style={{ fontSize: 12, opacity: 0.7 }}>Translator: {modelInfo}</div>
      )}

      {segments.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontWeight: 500 }}>
            Draft Segments ({segments.length}) — polish the English column
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: "left" }}>#</th>
                  <th style={{ width: "45%", textAlign: "left" }}>Korean</th>
                  <th style={{ width: "55%", textAlign: "left" }}>English (editable)</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((seg, idx) => (
                  <tr key={seg.id}>
                    <td style={{ verticalAlign: "top", padding: "4px 8px" }}>{seg.id}</td>
                    <td style={{ verticalAlign: "top", padding: "4px 8px" }}>
                      <textarea
                        value={seg.ko}
                        readOnly
                        rows={4}
                        style={{ width: "100%", fontSize: 14, background: "#f7f7f7" }}
                      />
                    </td>
                    <td style={{ verticalAlign: "top", padding: "4px 8px" }}>
                      <textarea
                        value={seg.en}
                        onChange={(e) => updateSegment(idx, "en", e.target.value)}
                        rows={4}
                        style={{ width: "100%", fontSize: 14 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={saveFinal} disabled={saveLoading}>
              {saveLoading ? "Saving…" : "Save & activate"}
            </button>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Saving will replace the active hybrid script immediately.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <label>Test a sentence (does it hit Prepared?)</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <textarea
            rows={2}
            style={{ flex: 1, minWidth: 260 }}
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="하나님은 사랑이십니다"
          />
          <button onClick={runTest} disabled={testLoading}>
            {testLoading ? "Testing…" : "Test match"}
          </button>
        </div>
        {testResult && (
          <pre style={{ background: "#111", color: "#0f0", padding: 12, whiteSpace: "pre-wrap" }}>
            {testResult}
          </pre>
        )}
      </div>

      {status && <div>{status}</div>}
    </div>
  );
}
