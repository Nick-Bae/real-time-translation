# backend/app/routes/hybrid.py
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import hybrid_store as hybrid_store_state
from app.hybrid_store import (
    Pair,
    rebuild_index,
    store_sermon_script,
    set_active_sermon,
    get_active_sermon_id,
    get_sermon_script,
    list_sermons,
    best_match_for_script,
)
from app.services import gpt_service

router = APIRouter()

logger = logging.getLogger("app.routes.hybrid")

SENTENCE_SPLIT_RE = re.compile(r"(?<=[\.!\?。！？])\s+")
DEFAULT_THRESHOLD = 0.84


def _split_korean_text(text: str, auto_split: bool = True) -> List[str]:
    """Split the uploaded Korean sermon text into candidate sentences."""
    clean = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    segments: List[str] = []
    for block in clean.split("\n"):
        block = block.strip()
        if not block:
            continue
        if not auto_split:
            segments.append(block)
            continue
        pieces = [p.strip() for p in SENTENCE_SPLIT_RE.split(block) if p.strip()]
        if not pieces:
            segments.append(block)
            continue
        segments.extend(pieces)
    # dedupe consecutive identical lines but keep order
    deduped: List[str] = []
    last = None
    for item in segments:
        if item == last:
            continue
        deduped.append(item)
        last = item
    return deduped


class UploadPayload(BaseModel):
    payload: Dict[str, Any]
    cfg: Dict[str, Any] | None = Field(default_factory=dict)


class DraftSegment(BaseModel):
    id: int
    ko: str
    en: str


class SermonDraftRequest(BaseModel):
    sermon_id: str
    korean: str
    auto_split: bool = True
    source_lang: str = "ko"
    target_lang: str = "en"
    threshold: float | None = None


class SermonDraftResponse(BaseModel):
    sermon_id: str
    segment_count: int
    threshold: float
    auto_split: bool
    target_lang: str
    translator: str
    model: str
    segments: List[DraftSegment]


class SermonFinalizeRequest(BaseModel):
    sermon_id: str
    segments: List[DraftSegment]
    threshold: float = DEFAULT_THRESHOLD
    activate: bool = True


class SermonActivateRequest(BaseModel):
    sermon_id: str


class SermonTestRequest(BaseModel):
    text: str
    sermon_id: str | None = None
    threshold: float | None = None


@router.post("/script/upload")
async def hybrid_upload(body: UploadPayload):
    """
    Legacy upload endpoint (still supported). Accepts {"payload":{"pairs":[...]}, "cfg":{"threshold":0.84, "sermon_id":...}}
    """
    pairs_raw = (body.payload or {}).get("pairs", [])
    cfg = body.cfg or {}
    current_threshold = getattr(hybrid_store_state, "HYBRID_THRESHOLD", DEFAULT_THRESHOLD)
    threshold = float(cfg.get("threshold", current_threshold))
    sermon_id = cfg.get("sermon_id")
    activate = bool(cfg.get("activate", True))

    pairs: List[Pair] = []
    for item in pairs_raw:
        src = (item.get("source") or "").strip()
        tgt = (item.get("target") or "").strip()
        if src and tgt:
            pairs.append(Pair(source=src, target=tgt))

    if sermon_id:
        script = store_sermon_script(sermon_id, pairs, threshold, activate=activate)
        return {
            "loaded": len(script.pairs),
            "threshold": script.threshold,
            "sermon_id": script.sermon_id,
            "active": script.sermon_id == get_active_sermon_id(),
        }

    # Legacy behaviour: set global script without sermon_id
    hybrid_store_state.HYBRID_SCRIPT = list(pairs)
    hybrid_store_state.HYBRID_THRESHOLD = threshold
    hybrid_store_state.ACTIVE_SERMON_ID = None
    rebuild_index()
    return {
        "loaded": len(hybrid_store_state.HYBRID_SCRIPT),
        "threshold": hybrid_store_state.HYBRID_THRESHOLD,
        "sermon_id": None,
        "active": False,
    }


@router.delete("/script")
async def hybrid_clear(clear_all: bool = False):
    """
    Clear the currently active script. If clear_all=True, drop all stored sermons.
    """
    from app.hybrid_store import clear_sermons

    if clear_all:
        clear_sermons()
        return {"cleared": True, "threshold": DEFAULT_THRESHOLD, "sermon_id": None, "active": None, "removed_all": True}

    hybrid_store_state.HYBRID_SCRIPT = []
    hybrid_store_state.HYBRID_THRESHOLD = DEFAULT_THRESHOLD
    hybrid_store_state.ACTIVE_SERMON_ID = None
    rebuild_index()
    return {
        "cleared": True,
        "threshold": hybrid_store_state.HYBRID_THRESHOLD,
        "sermon_id": None,
        "active": None,
    }


@router.post("/sermon/draft", response_model=SermonDraftResponse)
async def sermon_draft(body: SermonDraftRequest):
    segments = _split_korean_text(body.korean, body.auto_split)
    if not segments:
        raise HTTPException(status_code=400, detail="No sentences found after splitting")

    seen: Dict[str, str] = {}
    translated_segments: List[DraftSegment] = []
    for idx, sentence in enumerate(segments, start=1):
        if sentence in seen:
            translated = seen[sentence]
        else:
            try:
                translated = await asyncio.to_thread(
                    gpt_service.translate_text,
                    sentence,
                    body.source_lang,
                    body.target_lang,
                )
            except Exception:
                logger.exception("OpenAI translation failed; returning source sentence")
                translated = sentence
            seen[sentence] = translated
        translated_segments.append(DraftSegment(id=idx, ko=sentence, en=translated))

    current_threshold = getattr(hybrid_store_state, "HYBRID_THRESHOLD", DEFAULT_THRESHOLD)
    threshold = body.threshold or current_threshold or DEFAULT_THRESHOLD
    return SermonDraftResponse(
        sermon_id=body.sermon_id,
        segment_count=len(translated_segments),
        threshold=threshold,
        auto_split=body.auto_split,
        target_lang=body.target_lang,
        translator="openai_chatgpt",
        model=getattr(gpt_service, "model", "gpt-4o"),
        segments=translated_segments,
    )


@router.post("/sermon/finalize")
async def sermon_finalize(body: SermonFinalizeRequest):
    pairs: List[Pair] = []
    for seg in body.segments:
        src = (seg.ko or "").strip()
        tgt = (seg.en or "").strip()
        if not src or not tgt:
            continue
        pairs.append(Pair(source=src, target=tgt))

    if not pairs:
        raise HTTPException(status_code=400, detail="No valid segments supplied")

    script = store_sermon_script(body.sermon_id, pairs, body.threshold, activate=body.activate)
    active_id = get_active_sermon_id()
    return {
        "sermon_id": script.sermon_id,
        "stored": len(script.pairs),
        "threshold": script.threshold,
        "active": script.sermon_id == active_id,
        "created_at": script.created_at.isoformat(),
    }


@router.post("/sermon/activate")
async def sermon_activate(body: SermonActivateRequest):
    try:
        script = set_active_sermon(body.sermon_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Sermon '{body.sermon_id}' not found")
    return {
        "sermon_id": script.sermon_id,
        "segments": len(script.pairs),
        "threshold": script.threshold,
        "active": True,
        "created_at": script.created_at.isoformat(),
    }


@router.get("/sermon")
async def sermon_list():
    active_id = get_active_sermon_id()
    data = []
    for script in list_sermons():
        data.append(
            {
                "sermon_id": script.sermon_id,
                "segments": len(script.pairs),
                "threshold": script.threshold,
                "created_at": script.created_at.isoformat(),
                "active": script.sermon_id == active_id,
            }
        )
    return data


@router.post("/sermon/test")
async def sermon_test(body: SermonTestRequest):
    target_sermon_id = body.sermon_id or get_active_sermon_id()
    if not target_sermon_id:
        raise HTTPException(status_code=400, detail="No sermon_id provided and no active sermon set")
    script = get_sermon_script(target_sermon_id)
    if script is None:
        raise HTTPException(status_code=404, detail=f"Sermon '{target_sermon_id}' not found")

    score, en, matched_src = best_match_for_script(body.text, script, override_threshold=body.threshold)
    return {
        "sermon_id": target_sermon_id,
        "threshold": script.threshold if body.threshold is None else body.threshold,
        "score": score,
        "matched": matched_src,
        "translation": en,
        "segments": len(script.pairs),
    }
