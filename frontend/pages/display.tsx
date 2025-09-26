// pages/display.tsx
"use client";
import { useSubtitleSocket } from "../utils/useSubtitleSocket";

export default function Display() {
   const { connected, krInterim, krFinal, enFinal } =
    useSubtitleSocket(process.env.NEXT_PUBLIC_WS_URL
      ? `${process.env.NEXT_PUBLIC_WS_URL}?role=viewer`
      : undefined);

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "grid",
        placeItems: "center",
        background: "#000",
        color: "#fff",
        padding: "2rem",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      {/* status pill */}
      <div
        style={{
          position: "fixed",
          top: 12,
          right: 12,
          fontSize: 14,
          opacity: 0.85,
        }}
      >
        {connected ? "🟢 Connected" : "🔴 Disconnected"}
      </div>

      {/* subtitle block */}
      <div style={{ maxWidth: "92vw", textAlign: "center" }}>
        {/* Korean preview (interim) */}
        {/* {krInterim && (
          <div style={{ opacity: 0.6, fontSize: "3.5vw", marginBottom: "0.2em", fontStyle: "italic" }}>
            {krInterim}
          </div>
        )} */}

        {/* Korean committed (final) */}
        {krFinal && (
          <div style={{ opacity: 0.85, fontSize: "4vw", marginBottom: "0.35em" }}>
            {krFinal}
          </div>
        )}

        {/* English main line */}
        <div style={{ fontSize: "7vw", lineHeight: 1.15, wordBreak: "break-word", minHeight: "1.2em" }}>
          {enFinal || "— waiting —"}
        </div>
      </div>
    </div>
  );
}
