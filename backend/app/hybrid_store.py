# backend/app/hybrid_store.py
from __future__ import annotations
import asyncio
from pydantic import BaseModel, Field
from typing import Optional, Dict, Tuple
from rapidfuzz import fuzz, process
import unicodedata, re
from collections import OrderedDict
from datetime import datetime
from threading import Lock

class Pair(BaseModel):
    source: str  # KO
    target: str  # EN

# in-memory store
HYBRID_SCRIPT: list[Pair] = []
HYBRID_THRESHOLD: float = 0.84
ACTIVE_SERMON_ID: str | None = None
NORMALIZED_KO: list[str] = []
KO_INDEX_TO_EN: dict[int, str] = {}
KO_INDEX_TO_SRC: dict[int, str] = {}

class SermonScript(BaseModel):
    sermon_id: str
    threshold: float
    pairs: list[Pair]
    created_at: datetime = Field(default_factory=datetime.utcnow)

# sermon_id -> SermonScript
SERMON_STORE: Dict[str, SermonScript] = {}

TRANSLATION_CACHE: "OrderedDict[Tuple[str, str], str]" = OrderedDict()
TRANSLATION_CACHE_LOCK = Lock()
TRANSLATION_CACHE_LIMIT = 256

def _normalize_ko(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    return s

def rebuild_index() -> None:
    global NORMALIZED_KO, KO_INDEX_TO_EN, KO_INDEX_TO_SRC
    NORMALIZED_KO = [_normalize_ko(p.source) for p in HYBRID_SCRIPT]
    KO_INDEX_TO_EN = {i: HYBRID_SCRIPT[i].target for i in range(len(HYBRID_SCRIPT))}
    KO_INDEX_TO_SRC = {i: HYBRID_SCRIPT[i].source for i in range(len(HYBRID_SCRIPT))}
    with TRANSLATION_CACHE_LOCK:
        TRANSLATION_CACHE.clear()

def best_match_ko(ko_sentence: str) -> tuple[float, Optional[str], Optional[str]]:
    if not NORMALIZED_KO:
        return (0.0, None, None)
    q = _normalize_ko(ko_sentence)
    hit = process.extractOne(
        q, NORMALIZED_KO,
        scorer=fuzz.token_set_ratio,
        score_cutoff=int(HYBRID_THRESHOLD * 100),
    )
    if not hit:
        return (0.0, None, None)
    _, score, idx = hit
    return (
        score / 100.0,
        KO_INDEX_TO_EN.get(idx),
        KO_INDEX_TO_SRC.get(idx),
    )

def best_match_for_script(
    ko_sentence: str,
    script: SermonScript,
    override_threshold: Optional[float] = None,
) -> tuple[float, Optional[str], Optional[str]]:
    if script is None or not script.pairs:
        return (0.0, None, None)
    q = _normalize_ko(ko_sentence)
    normalized = [_normalize_ko(p.source) for p in script.pairs]
    threshold = override_threshold if override_threshold is not None else script.threshold
    hit = process.extractOne(
        q,
        normalized,
        scorer=fuzz.token_set_ratio,
        score_cutoff=int(float(threshold) * 100),
    )
    if not hit:
        return (0.0, None, None)
    _, score, idx = hit
    try:
        pair = script.pairs[idx]
    except IndexError:
        return (0.0, None, None)
    return (score / 100.0, pair.target, pair.source)

# You already have translate_text_generic in your codebase
from app.services.google_services import translate_text_generic

def _cache_key(origin_text: str, target_lang: str) -> Tuple[str, str]:
    return (_normalize_ko(origin_text), (target_lang or "").lower() or "en")

def _cache_get(origin_text: str, target_lang: str) -> Optional[str]:
    key = _cache_key(origin_text, target_lang)
    with TRANSLATION_CACHE_LOCK:
        if key not in TRANSLATION_CACHE:
            return None
        # move to end for LRU behaviour
        value = TRANSLATION_CACHE.pop(key)
        TRANSLATION_CACHE[key] = value
        return value

def _cache_put(origin_text: str, target_lang: str, translated: str) -> None:
    key = _cache_key(origin_text, target_lang)
    with TRANSLATION_CACHE_LOCK:
        if key in TRANSLATION_CACHE:
            TRANSLATION_CACHE.pop(key)
        TRANSLATION_CACHE[key] = translated
        while len(TRANSLATION_CACHE) > TRANSLATION_CACHE_LIMIT:
            TRANSLATION_CACHE.popitem(last=False)

async def match_and_translate(ko_text: str, target_lang: str = "en") -> dict:
    try:
        score, en, matched_src = best_match_ko(ko_text)
    except Exception:
        score, en, matched_src = (0.0, None, None)

    if en is not None and score >= HYBRID_THRESHOLD:
        return {
            "text": en,
            "origin": "script",
            "mode": "pre",
            "score": float(score),
            "matched_source": matched_src or ko_text,
        }

    loop = asyncio.get_running_loop()
    cached = _cache_get(ko_text, target_lang)
    if cached is not None:
        return {
            "text": cached,
            "origin": "cache",
            "mode": "realtime",
            "score": 0.0,
            "matched_source": None,
        }
    try:
        en_rt = await loop.run_in_executor(
            None, translate_text_generic, ko_text, "ko", target_lang
        )
    except Exception:
        en_rt = ko_text  # fail-open
    else:
        _cache_put(ko_text, target_lang, en_rt)
    return {
        "text": en_rt,
        "origin": "google",
        "mode": "realtime",
        "score": 0.0,
        "matched_source": None,
    }

def store_sermon_script(sermon_id: str, pairs: list[Pair], threshold: float, activate: bool = True) -> SermonScript:
    if not sermon_id:
        raise ValueError("sermon_id is required")
    script = SermonScript(
        sermon_id=sermon_id,
        threshold=float(threshold),
        pairs=list(pairs),
        created_at=datetime.utcnow(),
    )
    SERMON_STORE[sermon_id] = script
    if activate:
        set_active_sermon(sermon_id)
    return script

def set_active_sermon(sermon_id: str) -> SermonScript:
    global HYBRID_SCRIPT, HYBRID_THRESHOLD, ACTIVE_SERMON_ID
    script = SERMON_STORE.get(sermon_id)
    if script is None:
        raise KeyError(f"Sermon '{sermon_id}' not found")
    HYBRID_SCRIPT = list(script.pairs)
    HYBRID_THRESHOLD = float(script.threshold)
    ACTIVE_SERMON_ID = sermon_id
    rebuild_index()
    return script

def get_active_sermon_id() -> Optional[str]:
    return ACTIVE_SERMON_ID

def get_sermon_script(sermon_id: str) -> Optional[SermonScript]:
    return SERMON_STORE.get(sermon_id)

def list_sermons() -> list[SermonScript]:
    return sorted(SERMON_STORE.values(), key=lambda s: s.created_at, reverse=True)

def clear_sermons() -> None:
    global HYBRID_SCRIPT, HYBRID_THRESHOLD, ACTIVE_SERMON_ID
    SERMON_STORE.clear()
    HYBRID_SCRIPT = []
    HYBRID_THRESHOLD = 0.84
    ACTIVE_SERMON_ID = None
    rebuild_index()
