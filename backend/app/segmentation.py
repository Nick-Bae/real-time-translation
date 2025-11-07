# backend/app/segmentation.py
import time, re
from dataclasses import dataclass, field
from typing import Optional, Sequence

# ----- Lexicons ---------------------------------------------------------------

KO_MARKERS: Sequence[str] = (
    "그런데","근데","그래서","그러니까","하지만","그러나","그래도",
    "그리고","그리고 나서","그러면서","그럼","그때","왜냐하면"
)
KO_ENDERS: Sequence[str] = (
    "습니다","니다","다","요","죠","네요","였죠","였어요","해요","했어요","했죠",
    "합시다","합니까","거든요","거예요","거에요","더라고요"
)

KO_STICKY_SUFFIXES: Sequence[str] = ("함께", "같이")
# Sentence endings like "…합시다" sometimes arrive sticky with the next word (e.g., "합시다함께").
# Detect these so we can split right after the polite ending, even if whitespace slips in.
KO_STICKY_SENT_BOUNDARY_RE = re.compile(
    r"([가-힣]{2,}?다)(?=\s*(?:%s))" % "|".join(KO_STICKY_SUFFIXES)
)

_KO_ENDERS_SORTED = sorted(KO_ENDERS, key=len, reverse=True)
_KO_ENDER_PATTERN = "|".join(re.escape(end) for end in _KO_ENDERS_SORTED)
KO_INNER_ENDER_RE = re.compile(
    rf"([가-힣]{{2,}}(?:{_KO_ENDER_PATTERN}))(?=\s+[\"'“”‘’]*[가-힣A-Za-z0-9])"
)

# Put this near your other regexes (backend/app/segmentation.py)
EN_MARKERS: Sequence[str] = ("but","so","however","therefore","then","and then","because","and")
EN_END_PUNCT = ".?!"

_SPACE = re.compile(r"\s+")
_HANGUL = re.compile(r"[가-힣]")

def _norm(s: str) -> str:
    return _SPACE.sub(" ", s or "").strip()

# Punctuation we can ignore on the far right when judging endings
TRAIL_PUNCT = " .,!?:;…‥、。！？」］)}]“”‘’'\""

def _rstrip_tail_punct(s: str) -> str:
    i = len(s)
    while i > 0 and s[i - 1] in TRAIL_PUNCT:
        i -= 1
    return s[:i]

# Connective endings (commit-friendly early split points)
# AFTER (more permissive at clause tail; still blocks obvious partials)
# complete connective phrase (safe early split)
KO_CONNECTIVE_BOUNDARY_RE = re.compile(
    r"(?:(?:기\s*?)?때문에|"
    r"는데요?|지만요?|"
    r"(?:으)?니까|[아어]서|라서|"
    r"면서|다가|자마자|거나|거든|"
    r"며|으며|"
    r"(?:으)?면|다면"
    r")(?=[\s,．。!?…‥]|$)"
)


# a *hanging* connective (don’t commit on these yet)
# NOTE: Anchor alternatives so we never match the empty string; otherwise every sentence
# tail would look like a hanging connective and prevent timely commits.
KO_CONNECTIVE_HANGING_RE = re.compile(
    r"(?:"
    r"기\s*때(?:문|문에)|"
    r"때(?:문|문에)|"
    r"는?데|"
    r"지(?:만)?|"
    r"(?:으)?니|"
    r"[아어]서|"
    r"라서|"
    r"면서|"
    r"다가|"
    r"자마자|"
    r"거나|"
    r"거든|"
    r"며|"
    r"으며|"
    r"(?:으)?면|"
    r"다면|"
    r"(?:했|하|되(?:었)?|해)\s*기"
    r")\s*$"
)


KO_SENT_END_PUNCT_RE = re.compile(r"[．。!?…‥]$")


# Particles/adverbs we avoid ending on unless a connective has matched
KO_SUSPECT_TAIL_RE = re.compile(
    r"(?:은|는|이|가|을|를|에|에서|에게|께|로|으로|와|과|도|만|까지|부터|처럼|같이|"
    r"정말|진짜|아주|매우|너무|굉장히|잘|많이|조금|약간|의)\s*$"
)

def _ends_with_ko_ender(s: str) -> bool:
    return any(s.endswith(end) for end in KO_ENDERS)

def _looks_like_tail_marker(tail_head: str, *, lang: str = "ko") -> int:
    """If the new tail begins with a discourse marker, return the marker length; else 0."""
    if not tail_head:
        return 0
    if lang.startswith("en"):
        head_l = tail_head.lower()
        for mk in EN_MARKERS:
            if head_l.startswith(mk):
                return len(mk)
    else:
        for mk in KO_MARKERS:
            if tail_head.startswith(mk):
                # require at least 2 Hangul chars (avoid matching stray “그”)
                seen = sum(1 for ch in tail_head[:len(mk)] if _HANGUL.match(ch))
                if seen >= 2:
                    return len(mk)
    return 0

def _last_safe_split(s: str) -> Optional[int]:
    if not s:
        return None
    txt = s.rstrip()

    last_k: Optional[int] = None

    def _push(idx: int):
        nonlocal last_k
        if idx and (last_k is None or idx > last_k):
            last_k = idx

    # Sticky polite endings like "…다함께/다같이". If we see them, prefer splitting here
    for m in KO_STICKY_SENT_BOUNDARY_RE.finditer(txt):
        idx = m.end(1)
        rest = txt[idx:]
        if rest.strip():
            _push(idx)

    # Sentence punctuation (., !, ?, …) followed by more text → safe boundary before next clause
    for i, ch in enumerate(txt):
        if ch in "．.。!?…‥":
            rest = txt[i + 1 :]
            if rest.strip():
                _push(i + 1)

    # Plain sentence endings (…다/…습니다/…) immediately followed by another word without punctuation
    for m in KO_INNER_ENDER_RE.finditer(txt):
        idx = m.end(1)
        rest = txt[idx:]
        if rest.strip():
            _push(idx)

    for m in KO_CONNECTIVE_BOUNDARY_RE.finditer(txt):
        k = m.end()
        # pull in immediate trailing punctuation (.,，。 etc.) if it exists
        j = k
        while j < len(txt) and txt[j] in " ,．。!?…‥":
            # only swallow one punctuation token; stop before next word
            j += 1
            break
        # ignore if still hanging
        snippet = txt[:j]
        base = _rstrip_tail_punct(snippet)
        rest = txt[j:].lstrip()
        if KO_CONNECTIVE_HANGING_RE.search(base) and not rest:
            continue
        if rest.strip():
            _push(j)

    if last_k is not None:
        return last_k

    # full sentence ender (K polite/plain endings OR end punctuation) → emit entire buffer
    if KO_SENT_END_PUNCT_RE.search(txt) or _ends_with_ko_ender(txt):
        return len(txt)

    return None


# ----- Config -----------------------------------------------------------------

@dataclass
class CommitConfig:
    max_elapsed_s: float = 12.0
    max_chars: int = 42
    commit_on_tail_ender: bool = True
    commit_on_tail_marker: bool = True
    allow_internal_marker_split: bool = True
    translate_on_server: bool = False

# ----- Committer --------------------------------------------------------------

@dataclass
class ClauseCommitter:
    cfg: CommitConfig = field(default_factory=CommitConfig)
    lang: str = "ko"   # "ko" or "en"
    buf: str = ""
    last_commit_at: float = field(default_factory=time.time)
    last_left_len: int = 0               # <-- REQUIRED for early-commit logic
    last_emitted_left: str = ""          # simple guard against immediate duplicates
    
    def reset_for_new_utterance(self):
        self.buf = ""
        # If you track “last_left_len” or “last_emitted_left”, reset them too:
        if hasattr(self, "last_left_len"):
            self.last_left_len = 0
        if hasattr(self, "last_emitted_left"):
            self.last_emitted_left = ""
        self.last_commit_at = time.time()


    @property
    def markers(self) -> Sequence[str]:
        return EN_MARKERS if self.lang.startswith("en") else KO_MARKERS

    def _is_tail_ender(self, s: str) -> bool:
        """Detect a full sentence end (Korean polite/plain endings or end punctuation)."""
        t = (s or "").rstrip()
        if not t:
            return False
        if not self.lang.startswith("en"):
            base = _rstrip_tail_punct(t)
            # avoid treating hanging connective compounds as finished (e.g., "...했기.", "...이기.")
            if KO_CONNECTIVE_HANGING_RE.search(base):
                return False
            if base.endswith("기") and len(base) > 1:
                return False
        if self.lang.startswith("en"):
            return t[-1] in EN_END_PUNCT
        if t and t[-1] in ".?!…‥。！？」":
            return True
        if _ends_with_ko_ender(t):
            return True
        return False

    def _internal_marker_boundary(self, s: str) -> Optional[int]:
        """Fallback: split before an internal discourse marker if left fragment looks stable."""
        if not s:
            return None
        hay = s.lower() if self.lang.startswith("en") else s
        MIN_LEFT = 6
        for mk in self.markers:
            needle = mk if not self.lang.startswith("en") else mk.lower()
            k = hay.find(needle)
            if k <= 0:
                continue
            # require a boundary before marker
            if s[k - 1].isspace() or s[k - 1] in " ,.;:!?)」』])“”‘’—-…":
                left_core = _rstrip_tail_punct(s[:k])
                if len(_norm(left_core)) >= MIN_LEFT and not KO_SUSPECT_TAIL_RE.search(left_core):
                    return k
        return None

    def _should_emit(self, left: str) -> bool:
        left_n = _norm(left)
        if not left_n:
            return False
        if left_n == self.last_emitted_left:
            return False
        return True

    def _emit(self, left: str) -> str:
        left_n = _norm(left)
        self.last_emitted_left = left_n
        self.last_commit_at = time.time()
        self.last_left_len = len(left_n)
        return left_n

    def feed(self, interim: str) -> Optional[str]:
        if not interim:
            return None

        # Defensive: old objects created pre-field
        if not hasattr(self, "last_left_len"):
            self.last_left_len = 0
        if not hasattr(self, "last_emitted_left"):
            self.last_emitted_left = ""

        prev = self.buf
        inc = interim

        if prev:
            prev_norm = _norm(prev)
            inc_norm = _norm(inc)
            if inc_norm and len(inc_norm) < len(prev_norm) and prev_norm.endswith(inc_norm):
                inc = prev

        # 1) Split BEFORE a new tail marker (그런데/하지만/…) that just arrived
        if self.cfg.commit_on_tail_marker and not self.lang.startswith("en"):
            if prev and inc.startswith(prev):
                tail = inc[len(prev):]
                i = 0
                while i < len(tail) and tail[i].isspace():
                    i += 1
                head = tail[i:]
                mk_len = _looks_like_tail_marker(head, lang=self.lang)

                # NEW: topic-NP as a marker (commit BEFORE '내일은/오늘은/…')
                if mk_len:
                    left = inc[:len(prev)].rstrip()
                    if len(_norm(left)) >= 6 and self._should_emit(left):
                        self.buf = head
                        return self._emit(left)

        # keep latest snapshot
        self.buf = inc

        # 2) Connective/safe boundary early commit
        if not self.lang.startswith("en"):
            k = _last_safe_split(self.buf)
            if k and k > self.last_left_len:
                buf_snapshot = self.buf
                left = buf_snapshot[:k].rstrip()
                right = buf_snapshot[k:].lstrip()
                if len(_norm(left)) >= 6 and self._should_emit(left):
                    left_core = _rstrip_tail_punct(left)
                    if KO_SUSPECT_TAIL_RE.search(left_core):
                        self.buf = buf_snapshot
                    elif not right.strip() and KO_CONNECTIVE_HANGING_RE.search(left_core):
                        self.buf = buf_snapshot
                    else:
                        self.buf = right
                        return self._emit(left)

        # 3) Full sentence enders
        if self.cfg.commit_on_tail_ender and self._is_tail_ender(self.buf):
            out = _norm(self.buf)
            core = _rstrip_tail_punct(out)
            if KO_SUSPECT_TAIL_RE.search(core):
                return None
            if self._should_emit(out):
                self.buf = ""
                return self._emit(out)

        # 4) Internal marker split (fallback)
        if self.cfg.allow_internal_marker_split:
            b = self._internal_marker_boundary(self.buf)
            if b is not None and b > 2:
                left = self.buf[:b].rstrip()
                right = self.buf[b:].lstrip()
                if len(_norm(left)) >= 6 and self._should_emit(left):
                    self.buf = right
                    return self._emit(left)

        # 5) Whole-guard (time/length), try a safe split first; avoid hanging connective
        elapsed = time.time() - self.last_commit_at
        if len(_norm(self.buf)) >= self.cfg.max_chars or elapsed >= self.cfg.max_elapsed_s:
            k = _last_safe_split(self.buf)
            if k and k > self.last_left_len:
                left = self.buf[:k].rstrip()
                right = self.buf[k:].lstrip()
                if len(_norm(left)) >= 6 and self._should_emit(left):
                    left_core = _rstrip_tail_punct(left)
                    if KO_SUSPECT_TAIL_RE.search(left_core):
                        pass
                    else:
                        self.buf = right
                        return self._emit(left)
            # last resort: only emit whole if it doesn't end with a hanging connective
            if not KO_CONNECTIVE_HANGING_RE.search(self.buf):
                out = _norm(self.buf)
                core = _rstrip_tail_punct(out)
                if KO_SUSPECT_TAIL_RE.search(core):
                    return None
                if self._should_emit(out):
                    self.buf = ""
                    return self._emit(out)
        return None

    def force_flush(self) -> Optional[str]:
        if self.buf.strip():
            out = _norm(self.buf)
            if self._should_emit(out):
                self.buf = ""
                return self._emit(out)
        return None
