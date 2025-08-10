// pages/admin-hybrid.tsx
"use client";
import ScriptUpload from "../components/ScriptUpload";
import ProducerBox from "../components/ProducerBox";
import { useTranslationSocket } from "../utils/useTranslationSocket";

export default function AdminHybrid() {
  const { last } = useTranslationSocket(); // see latest broadcast

  return (
    <div style={{ padding:20, display:"grid", gap:24 }}>
      <h1>Hybrid Translation Admin</h1>
      <ScriptUpload />
      <ProducerBox />
      <div>
        <h3>Last Broadcast</h3>
        <pre style={{ background:"#111", color:"#0f0", padding:12 }}>
{JSON.stringify(last, null, 2)}
        </pre>
      </div>
    </div>
  );
}
