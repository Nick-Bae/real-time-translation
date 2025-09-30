# backend/app/routes/hybrid.py
from __future__ import annotations
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from app.hybrid_store import (
    Pair, HYBRID_SCRIPT, HYBRID_THRESHOLD, rebuild_index
)

router = APIRouter()

class UploadPayload(BaseModel):
    payload: dict  # expects {"pairs":[{source,target},...]}
    cfg: dict | None = {"threshold": 0.84}

@router.post("/script/upload")
async def hybrid_upload(body: UploadPayload):
    global HYBRID_SCRIPT, HYBRID_THRESHOLD
    pairs_raw = (body.payload or {}).get("pairs", [])
    HYBRID_THRESHOLD = float((body.cfg or {}).get("threshold", 0.84))

    HYBRID_SCRIPT = []
    for item in pairs_raw:
        src = (item.get("source") or "").strip()
        tgt = (item.get("target") or "").strip()
        if src and tgt:
            HYBRID_SCRIPT.append(Pair(source=src, target=tgt))

    rebuild_index()
    return {"loaded": len(HYBRID_SCRIPT), "threshold": HYBRID_THRESHOLD}

@router.delete("/script")
async def hybrid_clear():
    global HYBRID_SCRIPT, HYBRID_THRESHOLD
    HYBRID_SCRIPT = []
    HYBRID_THRESHOLD = 0.84
    rebuild_index()
    return {"cleared": True, "threshold": HYBRID_THRESHOLD}
