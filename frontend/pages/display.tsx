// pages/display.tsx
"use client";
import { useSubtitleSocket } from "../utils/useSubtitleSocket";

export default function Display() {
  const {
    connected,
    // krInterim,    if you want to show a faint preview
    krLines,
    enLines,
  } = useSubtitleSocket(
    process.env.NEXT_PUBLIC_WS_URL
      ? `${process.env.NEXT_PUBLIC_WS_URL}?role=viewer`
      : undefined,
    { maxLines: 3, track: "en" } // "en" | "kr" | "both"
  );

  const lastKr = krLines[krLines.length - 1] || "";

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
        fontFamily:
          "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      {/* status */}
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

      <div style={{ maxWidth: "92vw", textAlign: "center" }}>
        {/* Optional: KR preview line (faint) */}
        {/* {krInterim && (
          <div style={{ opacity: 0.5, fontSize: "3vw", marginBottom: "0.25em", fontStyle: "italic" }}>
            {krInterim}
          </div>
        )} */}

        {/* Last KR final (smaller, above EN) */}
        {lastKr && (
          <div style={{ opacity: 0.85, fontSize: "3.5vw", marginBottom: "0.4em" }}>
            {lastKr}
          </div>
        )}

        {/* EN multi-line (show newest at the bottom) */}
        <div style={{ lineHeight: 1.18 }}>
          {enLines.length > 0 ? (
            enLines.map((line, i) => (
              <div
                key={`${i}-${line.slice(0, 12)}`}
                style={{
                  fontSize: "7vw",
                  wordBreak: "break-word",
                  opacity: i < enLines.length - 1 ? 0.85 : 1, // make older lines a bit dimmer
                }}
              >
                {line}
              </div>
            ))
          ) : (
            <div style={{ fontSize: "7vw", opacity: 0.6 }}>— waiting —</div>
          )}
        </div>
      </div>
    </div>
  );
}
