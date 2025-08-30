# backend/app/chunker/ko_chunker.py
from __future__ import annotations
from typing import List, Optional

from app.utils.hangul import (
    tokenize_ko,
    has_particle,
    looks_connective,
    looks_rel_prenom,
    is_safe_adverbial,
    has_punct,
)

class KoChunker:
    """
    Clause-aware dynamic wait-k chunker for KO.
    - Keeps residual tokens across partials (so we don't re-commit the same text).
    - Fast-commits short adverbials/topics like “오늘 저녁에는 …”.
    - Never rewrites previously emitted chunks; caller should append-only.
    """

    def __init__(
        self,
        *,
        waitk_lo: int = 2,              # ↓ was 4; lower so short adverbials commit earlier
        waitk_hi: int = 7,
        silence_commit_ms: int = 450,   # ↓ faster pause commit
        max_precommit_tokens: int = 14,
    ) -> None:
        # Residual buffer = only uncommitted tokens
        self.buffer: List[str] = []
        # Last full snapshot of tokens (to compute LCP and only append deltas)
        self._prev_full: List[str] = []
        self.last_emit_at_ms: int = 0
        self.waitk_lo = waitk_lo
        self.waitk_hi = waitk_hi
        self.wait_k = waitk_lo
        self.silence_commit_ms = silence_commit_ms
        self.max_precommit_tokens = max_precommit_tokens

    def push_partial(self, partial: str, now_ms: int) -> list[str]:
        """
        Feed the *running* KO text (full interim transcript). Returns zero or more
        *new* KO chunks safe to commit now.
        """
        out: list[str] = []
        if not partial:
            return out

        incoming = tokenize_ko(partial)

        # --- Only APPEND the new suffix (compute Longest Common Prefix with previous full) ---
        lcp = 0
        n_prev = len(self._prev_full)
        n_inc = len(incoming)
        while lcp < n_prev and lcp < n_inc and self._prev_full[lcp] == incoming[lcp]:
            lcp += 1

        if lcp == 0 and n_prev > 0 and n_inc < n_prev:
            # ASR jumped/reset: treat incoming as a fresh view (avoid stale leftovers)
            self.buffer = incoming.copy()
        else:
            # append only the NEW tokens past the LCP
            new_tokens = incoming[lcp:]
            if new_tokens:
                self.buffer.extend(new_tokens)

        self._prev_full = incoming

        # --- Silence commit (short pause) ---
        if now_ms - self.last_emit_at_ms >= self.silence_commit_ms and self.buffer:
            s = self._commit_upto(len(self.buffer))
            if s:
                out.append(s)
                self.last_emit_at_ms = now_ms
            return out

        # --- Punctuation boundary ---
        joined_residual = " ".join(self.buffer)
        if has_punct(joined_residual):
            idx = max(joined_residual.rfind("."), joined_residual.rfind(","))
            if idx > 0:
                pre = joined_residual[: idx + 1].strip()
                pre_tok = tokenize_ko(pre)
                if pre_tok:
                    s = self._commit_upto(len(pre_tok))
                    if s:
                        out.append(s)
                        self.last_emit_at_ms = now_ms

        n = len(self.buffer)
        if n == 0:
            return out

        last = self.buffer[-1]

        # Adjust wait-k
        if looks_connective(last):
            self.wait_k = min(self.waitk_hi + 2, self.waitk_hi + 2)
        elif looks_rel_prenom(last):
            self.wait_k = self.waitk_hi
        elif is_safe_adverbial(last) or has_particle(last):
            self.wait_k = self.waitk_lo

        # --- FAST PATH: short adverbial/topic phrase ending with a particle ---
        # e.g., ["오늘", "저녁에는"] or ["오늘", "예배에"]
        if n <= 4 and has_particle(last):
            first = self.buffer[0]
            if is_safe_adverbial(first):
                s = self._commit_upto(n)
                if s:
                    out.append(s)
                    self.last_emit_at_ms = now_ms
                    return out

        # --- Normal safe-early logic (topics/adverbials/PPs) ---
        safe_idx = -1
        for i, tok in enumerate(self.buffer):
            nxt = self.buffer[i + 1] if i + 1 < n else ""
            safe = is_safe_adverbial(tok) or has_particle(tok)
            risky = looks_connective(tok) or looks_rel_prenom(tok)
            if safe and not risky:
                lookahead = max(0, n - (i + 1))
                if lookahead >= max(0, self.wait_k - 1):
                    safe_idx = i
            # Short PPs like “… 에/에서/으로/로”
            if tok in {"에서", "으로", "로", "에"} and nxt:
                safe_idx = max(safe_idx, i)

        if safe_idx >= 0:
            s = self._commit_upto(safe_idx + 1)
            if s:
                out.append(s)
                self.last_emit_at_ms = now_ms

        # --- Guard: too-long residual ---
        if len(self.buffer) >= self.max_precommit_tokens:
            s = self._commit_upto(self.max_precommit_tokens)
            if s:
                out.append(s + " …")
                self.last_emit_at_ms = now_ms

        return out

    def finalize(self, now_ms: int) -> list[str]:
        out: list[str] = []
        if self.buffer:
            s = self._commit_upto(len(self.buffer))
            if s:
                out.append(s)
                self.last_emit_at_ms = now_ms
        return out

    def _commit_upto(self, k: int) -> Optional[str]:
        if k <= 0:
            return None
        take = self.buffer[:k]
        self.buffer = self.buffer[k:]
        s = " ".join(take).strip()
        return s or None
