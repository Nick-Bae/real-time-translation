// utils/sentenceBuffer.ts
export type SentenceBufferConfig = {
  timeoutMs?: number;     // flush on silence
  minLength?: number;     // ignore super short bursts
};

const KOREAN_ENDINGS = [
  "요.", "니다.", "다.", "죠.", "함.", "함니다.", // common polite declaratives
  "?", "!", ".", "…", "…?", "…!"                 // punctuation
];

function normalize(s: string) {
  // collapse whitespace & normalize quotes
  return s
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/[\u3000\s]+/g, " ")
    .trim();
}

export class SentenceBuffer {
  private buf = "";
  private t?: ReturnType<typeof setTimeout>;
  private readonly timeoutMs: number;
  private readonly minLength: number;
  private onSentence: (s: string) => void;

  constructor(onSentence: (s: string) => void, cfg: SentenceBufferConfig = {}) {
    this.onSentence = onSentence;
    this.timeoutMs = cfg.timeoutMs ?? 1200; // ~1.2s of silence
    this.minLength = cfg.minLength ?? 4;
  }

  private isSentenceEnd(text: string) {
    const t = text.trim();
    return KOREAN_ENDINGS.some(suf => t.endsWith(suf));
  }

  private scheduleFlush() {
    if (this.t) clearTimeout(this.t);
    this.t = setTimeout(() => this.flush(true), this.timeoutMs);
  }

  /** Add partial STT chunk (interim or final). */
  add(chunk: string) {
    const c = normalize(chunk);
    if (!c) return;

    this.buf = this.buf ? `${this.buf} ${c}` : c;

    // If we hit sentence end punctuation, flush immediately
    if (this.isSentenceEnd(this.buf)) {
      this.flush(false);
    } else {
      // otherwise schedule flush on silence
      this.scheduleFlush();
    }
  }

  /** Force flush, e.g., at end of utterance or timeout. */
  flush(fromTimeout = false) {
    if (this.t) {
      clearTimeout(this.t);
      this.t = undefined;
    }
    const out = normalize(this.buf);
    this.buf = "";

    // Ignore tiny fragments unless we timed out and still want them
    if (!out) return;
    if (!fromTimeout && out.length < this.minLength) return;

    this.onSentence(out);
  }

  /** Reset current buffer (e.g., when switching speakers or languages). */
  reset() {
    if (this.t) clearTimeout(this.t);
    this.t = undefined;
    this.buf = "";
  }

  /** For debugging */
  peek() {
    return this.buf;
  }
}
