// utils/useSentenceBuffer.ts
import { useMemo, useRef } from "react";
import { SentenceBuffer, SentenceBufferConfig } from "./sentenceBuffer";

export function useSentenceBuffer(
  onSentence: (s: string) => void,
  cfg: SentenceBufferConfig = {}
) {
  const onSentenceRef = useRef(onSentence);
  onSentenceRef.current = onSentence;

  const buffer = useMemo(
    () =>
      new SentenceBuffer((s) => onSentenceRef.current(s), cfg),
    [cfg.timeoutMs, cfg.minLength] // config changes rebuild buffer
  );

  return buffer;
}
