# app/main.py
import os, json
import asyncio
import re
from typing import List, Optional, Literal, Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, Body, APIRouter  # ✅ APIRouter added
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field

# Your existing modules
from app.routes import translate as translate_routes
from app.socket_manager import manager
from app.utils.translate import translate_text as _translate_sync  # your current translator

import inspect, logging
log = logging.getLogger("rt")  # ✅ logger defined

# ---- translator alias (works with translate_text or translate_api; sync/async) ----
try:
    from app.utils.translate import translate_text as _translate_impl  # type: ignore
except Exception:
    from app.utils.translate import translate_api as _translate_impl  # type: ignore

async def translate_text(text: str, src: str, tgt: str) -> str:
    res = _translate_impl(text, src, tgt)
    if inspect.isawaitable(res):
        return await res
    return res

def norm(code: str | None) -> str:
    return (code or '').lower().split('-')[0]

# ---------------------------
# App setup
# ---------------------------
app = FastAPI(title="Hybrid Real-Time Translation Backend", version="0.3.0")
router = APIRouter()  # ✅ router created
load_dotenv()

# Allow dev origins (you can tighten later)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # ✅ open for dev; restrict in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keep your existing HTTP routes
app.include_router(translate_routes.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "Server is live"}

# ---------------------------
# ===== Hybrid Mode Additions =====
# ---------------------------
try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    _HAS_SK = True
except Exception:
    _HAS_SK = False

class ScriptPair(BaseModel):
    source: str = Field(..., description="Original sentence in Korean")
    target: str = Field(..., description="Pre-translated sentence in English")

class UploadScriptRequest(BaseModel):
    pairs: List[ScriptPair]

class MatchConfig(BaseModel):
    threshold: float = Field(0.84, ge=0.0, le=1.0)
    method: Literal["tfidf"] = "tfidf"

class TranslateIn(BaseModel):
    text: str
    source_lang: str = "ko"
    target_lang: str = "en"

class TranslateOut(BaseModel):
    translated: str
    mode: Literal["pre", "realtime"]
    match_score: float
    matched_source: Optional[str] = None
    method: str = "tfidf"
    original: Optional[str] = None

_punct_re = re.compile(r"[\u3000\s]+")
_quotes_re = re.compile(r"[\u2018\u2019\u201C\u201D]")

def normalize(s: str) -> str:
    s = s.strip()
    s = _quotes_re.sub('"', s)
    s = _punct_re.sub(' ', s)
    return s

class ScriptStore:
    def __init__(self):
        self.pairs: List[ScriptPair] = []
        self._vectorizer = None
        self._matrix = None
        self._norm_sources: List[str] = []
        self.config = MatchConfig()

    def load(self, pairs: List[ScriptPair]):
        if not _HAS_SK:
            raise HTTPException(status_code=500, detail="scikit-learn not installed; cannot build matcher")
        self.pairs = pairs
        self._norm_sources = [normalize(p.source) for p in pairs]
        self._vectorizer = TfidfVectorizer(ngram_range=(1, 2), analyzer="char_wb", min_df=1)
        self._matrix = self._vectorizer.fit_transform(self._norm_sources)

    def clear(self):
        self.pairs = []
        self._vectorizer = None
        self._matrix = None
        self._norm_sources = []

    def is_ready(self) -> bool:
        return bool(self.pairs) and self._vectorizer is not None and self._matrix is not None

    def best_match(self, text: str):
        if not self.is_ready():
            return 0.0, None, None
        q = normalize(text)
        qv = self._vectorizer.transform([q])
        sims = cosine_similarity(qv, self._matrix)[0]
        idx = int(sims.argmax())
        score = float(sims[idx])
        matched_src = self._norm_sources[idx]
        return score, self.pairs[idx], matched_src

STORE = ScriptStore()

# Use your existing translator in a thread-safe async wrapper (not used by WS alias, but kept)
async def translate_fallback(text: str, source_lang: str = "ko", target_lang: str = "en") -> str:
    return await asyncio.to_thread(_translate_sync, text, source_lang, target_lang)

@app.get("/api/health")
def health():
    return {"status": "ok", "script_loaded": STORE.is_ready(), "pairs": len(STORE.pairs)}

@app.post("/api/script/upload")
def upload_script(payload: UploadScriptRequest, cfg: MatchConfig = Body(default=MatchConfig())):
    if not payload.pairs:
        raise HTTPException(status_code=400, detail="No pairs provided")
    STORE.load(payload.pairs)
    STORE.config = cfg
    return {"ok": True, "loaded": len(payload.pairs), "method": cfg.method, "threshold": cfg.threshold}

@app.delete("/api/script")
def clear_script():
    STORE.clear()
    return {"ok": True}

@app.post("/api/translate", response_model=TranslateOut)
async def translate_api(inp: TranslateIn):
    if STORE.is_ready():
        score, pair, matched_src = STORE.best_match(inp.text)
        if score >= STORE.config.threshold and pair:
            return TranslateOut(
                translated=pair.target,
                mode="pre",
                match_score=score,
                matched_source=matched_src,
                method=STORE.config.method,
                original=inp.text,
            )
    translated = await translate_fallback(inp.text, inp.source_lang, inp.target_lang)
    return TranslateOut(
        translated=translated,
        mode="realtime",
        match_score=0.0,
        matched_source=None,
        method=STORE.config.method,
        original=inp.text,
    )

# ---------------------------
# WebSocket: producer + listeners
# ---------------------------
# app/main.py (replace only the ws_translate function)
@router.websocket("/ws/translate")
async def ws_translate(ws: WebSocket):
    await manager.connect(ws)

    # per-connection state
    partial_task: asyncio.Task | None = None
    debounce_task: asyncio.Task | None = None
    committed_kr_by_seg: dict[int, str] = {}  # accumulate KR commits per segment

    async def translate_and_broadcast(text: str, src: str, tgt: str, is_partial: bool, seg_id, rev, mode="realtime"):
        out = await translate_text(text, src, tgt)
        await manager.broadcast({
            "type": "translation",
            "payload": out,
            "lang": tgt,
            "meta": {
                "partial": is_partial,
                "segment_id": seg_id,
                "rev": rev,
                "mode": mode,
                "translated": out,
            },
        })

    def norm_ws(s: str) -> str:
        return " ".join((s or "").split())

    def strip_prefix(full: str, prefix: str) -> str:
        f, p = norm_ws(full), norm_ws(prefix)
        if not p:
            return full
        if f.startswith(p):
            # find the slice index by length of normalized prefix
            want = len(p)
            seen = 0
            for i, ch in enumerate(full):
                seen += (0 if ch.isspace() else 1)
                if seen >= want:
                    return full[i+1:].lstrip()
        return full

    async def schedule_partial(text: str, src: str, tgt: str, seg_id, rev):
        nonlocal partial_task, debounce_task
        # cancel older debounce/partial
        if debounce_task and not debounce_task.done():
            debounce_task.cancel()
        if partial_task and not partial_task.done():
            partial_task.cancel()

        async def _debounced():
            try:
                # small debounce so we don't translate every keystroke-like interim
                await asyncio.sleep(0.12)
                partial_task = asyncio.create_task(
                    translate_and_broadcast(text, src, tgt, True, seg_id, rev)
                )
                await partial_task
            except asyncio.CancelledError:
                pass

        debounce_task = asyncio.create_task(_debounced())

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            src = norm(msg.get("source"))
            tgt = norm(msg.get("target"))

            if mtype == "producer_partial":
                # translate latest partial with debounce; drop older ones
                await schedule_partial(msg.get("text",""), src, tgt, msg.get("id"), msg.get("rev"))
                continue

            if mtype == "producer_commit":
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                seg_id = int(msg.get("id") or 0)
                rev = int(msg.get("rev") or 0)
                is_final = bool(msg.get("final"))

                # cancel any in-flight partial work
                if debounce_task and not debounce_task.done():
                    debounce_task.cancel()
                if partial_task and not partial_task.done():
                    partial_task.cancel()

                if not is_final:
                    # accumulate KR for this seg (for later final suppression)
                    prev = committed_kr_by_seg.get(seg_id, "")
                    committed_kr_by_seg[seg_id] = (prev + (" " if prev and not prev.endswith(" ") else "") + text).strip()

                    # translate immediately
                    await translate_and_broadcast(text, src, tgt, False, seg_id, rev)
                else:
                    # ASR final → only translate the delta beyond what we've committed
                    prev = committed_kr_by_seg.get(seg_id, "")
                    delta = strip_prefix(text, prev)
                    # if nothing new (or extremely small), skip final
                    if len(norm_ws(delta)) < 2:
                        # no-op: we've already sent all pieces
                        continue
                    await translate_and_broadcast(delta, src, tgt, False, seg_id, rev, mode="realtime")
                    # clear seg accumulator
                    committed_kr_by_seg.pop(seg_id, None)

            elif mtype == "consumer_join":
                log.info("consumer joined")
            else:
                log.debug(f"unknown ws msg: {msg}")

    except Exception as e:
        log.warning(f"ws closed: {e}")
    finally:
        manager.disconnect(ws)


# ---------------------------
# Keep your existing broadcast endpoint
# ---------------------------
@app.post("/api/broadcast")
async def broadcast_translation(request: Request):
    data = await request.json()
    text = data.get("text", "")
    lang = data.get("lang", "en")

    payload = {
        "type": "translation",
        "payload": text,
        "lang": lang,
    }

    print("📡 Broadcasting translation:", payload)
    await manager.broadcast(payload)
    return {"message": "Broadcasted"}

# ✅ mount the WebSocket router at the very end
app.include_router(router)
