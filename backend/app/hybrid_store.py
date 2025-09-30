# backend/app/hybrid_store.py
from __future__ import annotations
from pydantic import BaseModel
from typing import Optional
from rapidfuzz import fuzz, process
import unicodedata, re

class Pair(BaseModel):
    source: str  # KO
    target: str  # EN

# in-memory store
HYBRID_SCRIPT: list[Pair] = []
HYBRID_THRESHOLD: float = 0.84
NORMALIZED_KO: list[str] = []
KO_INDEX_TO_EN: dict[int, str] = {}

def _normalize_ko(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    return s

def rebuild_index() -> None:
    global NORMALIZED_KO, KO_INDEX_TO_EN
    NORMALIZED_KO = [_normalize_ko(p.source) for p in HYBRID_SCRIPT]
    KO_INDEX_TO_EN = {i: HYBRID_SCRIPT[i].target for i in range(len(HYBRID_SCRIPT))}

def best_match_ko(ko_sentence: str) -> tuple[float, Optional[str]]:
    if not NORMALIZED_KO:
        return (0.0, None)
    q = _normalize_ko(ko_sentence)
    hit = process.extractOne(
        q, NORMALIZED_KO,
        scorer=fuzz.token_set_ratio,
        score_cutoff=int(HYBRID_THRESHOLD * 100),
    )
    if not hit:
        return (0.0, None)
    _, score, idx = hit
    return (score / 100.0, KO_INDEX_TO_EN.get(idx))

# You already have translate_text_generic in your codebase
from app.services.google_services import translate_text_generic

async def match_and_translate(ko_text: str, target_lang: str = "en") -> dict:
    try:
        score, en = best_match_ko(ko_text)
    except Exception:
        score, en = (0.0, None)

    if en is not None and score >= HYBRID_THRESHOLD:
        return {"text": en, "origin": "script", "score": float(score)}

    try:
        en_rt = translate_text_generic(ko_text, source_lang="ko", target_lang=target_lang)
    except Exception:
        en_rt = ko_text  # fail-open
    return {"text": en_rt, "origin": "rt", "score": 0.0}
