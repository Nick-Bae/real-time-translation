// pages/display.tsx
"use client";
import { useTranslationSocket } from "../utils/useTranslationSocket";

export default function Display() {
  const { connected, last } = useTranslationSocket(); // listener by default
  const badge = last.mode === "pre" ? "Prepared" : "Live";
  const score = last.mode === "pre" ? `· score ${last.matchScore.toFixed(2)}` : "";

  return (
    <div style={{
      height: "100vh", width: "100vw",
      display: "grid", placeItems: "center",
      background: "#000", color: "#fff", padding: "2rem"
    }}>
      <div style={{ position: "fixed", top: 12, right: 12, fontSize: 14, opacity: 0.85 }}>
        {connected ? "🟢 Connected" : "🔴 Disconnected"} · {badge} {score}
      </div>
      <div style={{
        maxWidth: "90vw",
        fontSize: "7vw",
        lineHeight: 1.2,
        textAlign: "center",
        wordBreak: "break-word",
      }}>
        
        {last.preview && (
          <div style={{ opacity: 0.6, fontSize: '3.5vw', marginBottom: '0.5rem', fontStyle: 'italic' }}>
            {last.preview}
          </div>
        )}
        <div style={{ fontSize: '7vw', lineHeight: 1.2 }}>
          {last.text || '— waiting —'}
        </div>

      </div>
    </div>
  );
}
