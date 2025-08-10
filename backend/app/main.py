import os, json
import asyncio
import re
from typing import List, Optional, Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field

# Your existing modules
from app.routes import translate as translate_routes
from app.socket_manager import manager
from app.utils.translate import translate_text as _translate_sync  # your current translator

# ---------------------------
# App setup
# ---------------------------
app = FastAPI(title="Hybrid Real-Time Translation Backend", version="0.3.0")
load_dotenv()

origins = os.getenv("ALLOWED_ORIGINS", "").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Keep your existing router
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

# Use your existing translator in a thread-safe async wrapper
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
@app.websocket("/ws/translate")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            try:
                inp = json.loads(raw)
            except Exception:
                await websocket.send_text(json.dumps({"error": "invalid_json"}))
                continue

            text = (inp.get("text") or "").strip()
            source_lang = inp.get("source_lang", "ko")
            target_lang = inp.get("target_lang", "en")
            partial = bool(inp.get("partial", False))
            segment_id = inp.get("segment_id", None)
            rev = int(inp.get("rev", 0))  # optional from client

            if not text:
                await websocket.send_text(json.dumps({"error": "empty_text"}))
                continue

            # Try scripted match first
            if STORE.is_ready():
                score, pair, matched_src = STORE.best_match(text)
                if score >= STORE.config.threshold and pair:
                    out = TranslateOut(
                        translated=pair.target,
                        mode="pre",
                        match_score=score,
                        matched_source=matched_src,
                        method=STORE.config.method,
                        original=text,
                    ).dict()
                    meta = {**out, "partial": partial, "segment_id": segment_id, "rev": rev}
                    await manager.broadcast({
                        "type": "translation",
                        "lang": target_lang,
                        "payload": out["translated"],
                        "meta": meta,
                    })
                    await websocket.send_text(json.dumps(meta, ensure_ascii=False))
                    continue

            # Fallback live translation (also for partials)
            translated = await translate_fallback(text, source_lang, target_lang)
            out = TranslateOut(
                translated=translated,
                mode="realtime",
                match_score=0.0,
                matched_source=None,
                method=STORE.config.method,
                original=text,
            ).dict()

            meta = {**out, "partial": partial, "segment_id": segment_id, "rev": rev}
            await manager.broadcast({
                "type": "translation",
                "lang": target_lang,
                "payload": out["translated"],
                "meta": meta,
            })
            await websocket.send_text(json.dumps(meta, ensure_ascii=False))

    except WebSocketDisconnect:
        await manager.disconnect(websocket)
        print("❌ Listener/producer disconnected")

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
