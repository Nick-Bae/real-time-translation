# backend/app/utils/assembler.py
from __future__ import annotations
from dataclasses import dataclass

def _tok(s: str) -> list[str]:
    return [t for t in s.replace("\n", " ").split(" ") if t]

@dataclass
class RunningTextAssembler:
    """
    Stitches incoming ASR partials into a running buffer.
    Works with three modes:
      - 'full'  : each partial is the full interim transcript -> replace
      - 'delta' : each partial is just the new piece -> append
      - 'auto'  : guess based on overlap/length
    """
    mode: str = "auto"  # 'auto' | 'full' | 'delta'
    max_len_tokens: int = 64

    full_view: str = ""
    delta_accum: str = ""
    last_text: str = ""

    def feed(self, text: str) -> str:
        text = (text or "").strip()
        if not text:
            return self.view()

        m = self.mode
        if m == "full":
            self.full_view = text
            self.delta_accum = ""
            self.last_text = text
            return self.view()

        if m == "delta":
            self.delta_accum = (self.delta_accum + " " + text).strip()
            self.last_text = text
            return self.view()

        # auto: guess
        # Heuristic: very short (≤2 tokens or ≤7 chars) → delta; otherwise try full
        toks = _tok(text)
        if len(toks) <= 2 or len(text) <= 7:
            self.delta_accum = (self.delta_accum + " " + text).strip()
            self.last_text = text
            return self.view()

        # If "text" contains most of delta_accum as prefix, treat as full
        if self.delta_accum and text.startswith(self.delta_accum[: max(1, int(0.6 * len(self.delta_accum)))]):
            self.full_view = text
            self.delta_accum = ""
            self.last_text = text
            return self.view()

        # Otherwise, append as delta
        self.delta_accum = (self.delta_accum + " " + text).strip()
        self.last_text = text
        return self.view()

    def view(self) -> str:
        combined = (self.full_view + " " + self.delta_accum).strip()
        toks = _tok(combined)
        if len(toks) > self.max_len_tokens:
            combined = " ".join(toks[-self.max_len_tokens :])
        return combined
