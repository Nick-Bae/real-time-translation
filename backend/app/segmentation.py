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

# Put this near your other regexes (backend/app/segmentation.py)
KO_TAIL_TOPIC_NP = re.compile(
    r"^(?:오늘|내일|어제|지금|그때|이제|다음|그리고|또|또한|한편|"
    r"저|제|나|내|우리|여러분|형제자매|형제들|자매들)\s*(?:은|는)\b"
)

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
KO_CONNECTIVE_HANGING_RE = re.compile(
    r"(?:기\s*때(?:문|문에?$)|때(?:문|문에?$)|"
    r"는?데$|지(?:만?$)|"
    r"(?:으)?니?$|[아어]서?$|라서?$|"
    r"면서?$|다가?$|자마자?$|거나?$|거든?$|"
    r"며$|으며?$|"
    r"(?:으)?면?$|다면?$)"
)


KO_SENT_END_PUNCT_RE = re.compile(r"[．。!?…‥]$")


# Particles/adverbs we avoid ending on unless a connective has matched
KO_SUSPECT_TAIL_RE = re.compile(
    r"(?:은|는|이|가|을|를|에|에서|에게|께|로|으로|와|과|도|만|까지|부터|처럼|같이|"
    r"정말|진짜|아주|매우|너무|굉장히|잘|많이|조금|약간)\s*$"
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

    # full sentence ender (K polite/plain endings OR end punctuation)
    if KO_SENT_END_PUNCT_RE.search(txt) or _ends_with_ko_ender(txt):
        return len(txt)

    last_k = None
    for m in KO_CONNECTIVE_BOUNDARY_RE.finditer(txt):
        k = m.end()
        # pull in immediate trailing punctuation (.,，。 etc.) if it exists
        j = k
        while j < len(txt) and txt[j] in " ,．。!?…‥":
            # only swallow one punctuation token; stop before next word
            j += 1
            break
        # ignore if still hanging
        if not KO_CONNECTIVE_HANGING_RE.search(txt[:k]):
            last_k = j
    return last_k


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
        self.last_left_len = 0
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
                if mk_len == 0 and KO_TAIL_TOPIC_NP.search(head):
                    mk_len = 1  # any positive → triggers the same logic

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
                left = self.buf[:k].rstrip()
                right = self.buf[k:].lstrip()
                if len(_norm(left)) >= 6 and self._should_emit(left):
                    self.buf = right
                    return self._emit(left)

        # 3) Full sentence enders
        if self.cfg.commit_on_tail_ender and self._is_tail_ender(self.buf):
            out = _norm(self.buf)
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
                    self.buf = right
                    return self._emit(left)
            # last resort: only emit whole if it doesn't end with a hanging connective
            if not KO_CONNECTIVE_HANGING_RE.search(self.buf):
                out = _norm(self.buf)
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
