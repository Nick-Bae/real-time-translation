// components/ScriptUpload.tsx
"use client";
import { useState } from "react";
import { API_URL } from "../utils/urls";

export default function ScriptUpload() {
  const [ko, setKo] = useState("");
  const [en, setEn] = useState("");
  const [threshold, setThreshold] = useState<number>(0.84);
  const [status, setStatus] = useState<string>("");

 const upload = async () => {
  const koLines = ko.split("\n").map(s => s.trim()).filter(Boolean);
  const enLines = en.split("\n").map(s => s.trim()).filter(Boolean);
  if (koLines.length !== enLines.length) {
    setStatus(`❌ Lines mismatch: KO=${koLines.length} vs EN=${enLines.length}`);
    return;
  }
  const pairs = koLines.map((k, i) => ({ source: k, target: enLines[i] }));

  try {
    const res = await fetch(`${API_URL}/api/script/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { pairs },      // 👈 wrap in payload
        cfg: { threshold }       // 👈 wrap in cfg
      }),
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      // show FastAPI validation details if present
      const detail = (j && j.detail) ? JSON.stringify(j.detail) : res.statusText;
      throw new Error(detail || "Upload failed");
    }
    setStatus(`✅ Uploaded ${j.loaded} pairs. threshold=${j.threshold}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`❌ ${msg}`);
  }
};


  const clearScript = async () => {
    try {
      const res = await fetch(`${API_URL}/api/script`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || "Clear failed");
      setStatus("🗑️ Cleared pre‑script");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`❌ ${msg}`);
    }
  };

  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ fontWeight:600 }}>Upload Pre‑Translated Script</div>

      <div style={{ display:"grid", gap:8 }}>
        <label>Korean (one sentence per line)</label>
        <textarea value={ko} onChange={e=>setKo(e.target.value)} rows={8} style={{ width:"100%" }} />
      </div>

      <div style={{ display:"grid", gap:8 }}>
        <label>English (one sentence per line)</label>
        <textarea value={en} onChange={e=>setEn(e.target.value)} rows={8} style={{ width:"100%" }} />
      </div>

      <div>
        <label>Match threshold:&nbsp;</label>
        <input
          type="number" step="0.01" min={0} max={1}
          value={threshold}
          onChange={e=>setThreshold(parseFloat(e.target.value || "0.84"))}
        />
      </div>

      <div style={{ display:"flex", gap:8 }}>
        <button onClick={upload}>Upload</button>
        <button onClick={clearScript}>Clear</button>
      </div>

      <div>{status}</div>
    </div>
  );
}
