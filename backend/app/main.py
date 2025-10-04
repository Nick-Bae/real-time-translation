from __future__ import annotations

import os
import json
import asyncio
import logging
import pathlib
import threading, time
from typing import Deque, Iterable, Optional
from collections import deque
import google.auth
from google.oauth2 import service_account

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File  # <-- FIXED
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from asyncio import CancelledError
from typing import Set
from starlette.websockets import WebSocketState
from urllib.parse import parse_qs
from rapidfuzz import fuzz, process
import unicodedata
import re

# Local modules
from app.socket_manager import manager
from app.deepgram_session import connect_to_deepgram
from app.utils.translate import translate_text
from app.routes import translate as translate_routes
from app.routes import hybrid as hybrid_routes
from app.hybrid_store import match_and_translate 
from app.services.google_services import (
    stt_kr_from_bytes_sync,
    translate_kr_to_en,
    tts_en_to_mp3,
    list_voices,
    stt_streaming_transcripts,
    debug_log_speech_paths,
    ensure_global_recognizer,
    # translate_text_generic
)


# ---- Optional: existing routers
from app.routes import translate as translate_routes  # keeps your /api endpoints

# ------------------------------------------------------------------------------
# Logging (configure once)
# ------------------------------------------------------------------------------
logger = logging.getLogger("app.main")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)
logger.setLevel(logging.INFO)

# ------------------------------------------------------------------------------
# Load .env deterministically (backend/.env)
# ------------------------------------------------------------------------------
ENV_PATH = str(pathlib.Path(__file__).resolve().parents[1] / ".env")
load_dotenv(dotenv_path=ENV_PATH, override=True)

# Log key paths once env is loaded
debug_log_speech_paths()

# Hard fail early if creds file missing
creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
print("GOOGLE_APPLICATION_CREDENTIALS:", creds_path)

# If a path is set but not found, just warn and fall back to ADC.
if creds_path and not os.path.exists(creds_path):
    print(f"[auth] Warning: creds file not found at {creds_path}. Falling back to ADC.")


# ------------------------------------------------------------------------------
# FastAPI setup
# ------------------------------------------------------------------------------
app = FastAPI(title="Real-Time Translation Backend", version="1.0.0")
PROD_ORIGINS = [
    "https://worshiptranslate.com",
    "https://www.worshiptranslate.com",
    # keep localhost for dev; drop if you don't need it
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

# allow all preview deployments on vercel (e.g. https://foo-bar-123.vercel.app)
VERCEL_PREVIEW_REGEX = r"https://.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=PROD_ORIGINS,          # explicit origins only (no "*")
    allow_origin_regex=VERCEL_PREVIEW_REGEX,  # previews
    allow_credentials=True,              # only works with explicit origins
    allow_methods=["GET", "POST", "OPTIONS"], # tighten to what you actually use
    allow_headers=["Authorization", "Content-Type"],  # add others if truly needed
    max_age=86400,                       # cache preflight for 24h
)

# Keep your existing HTTP routes under /api
app.include_router(translate_routes.router, prefix="/api")
app.include_router(hybrid_routes.router,    prefix="/api")  # <-- add this

VIEWERS: Set[WebSocket] = set()
VIEWERS_LOCK = asyncio.Lock()

def get_google_credentials(scopes=None):
    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if path:
        try:
            return service_account.Credentials.from_service_account_file(path, scopes=scopes)
        except Exception as e:
            print(f"[auth] Could not load creds from {path}: {e}. Falling back to ADC.")
    creds, _ = google.auth.default(scopes=scopes)  # ADC on Cloud Run
    return creds

async def broadcast(payload: dict):
    """Send a JSON payload to all connected viewers (best-effort)."""
    dead: list[WebSocket] = []
    async with VIEWERS_LOCK:
        for ws in list(VIEWERS):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            try:
                VIEWERS.remove(ws)
            except KeyError:
                pass

# Simple root for liveness
@app.get("/")
def root():
    return {"ok": True, "msg": "server is live"}

@app.get("/healthz")
def healthz():
    return {"ok": True}


# Example body model if you need it later
class KRIn(BaseModel):
    text_kr: str

# ------------------------------------------------------------------------------
# Debug endpoint: echo bytes back as counters (to verify WS + mic flow)
# ------------------------------------------------------------------------------
@app.websocket("/ws/echo-bytes")
async def ws_echo(ws: WebSocket):
    await ws.accept()
    total = 0
    try:
        async for b in ws.iter_bytes():
            n = len(b or b"")
            total += n
            # bounce a tiny JSON every ~10 chunks so browser prints something
            if total % (640 * 10) == 0:
                await ws.send_json({"echo_bytes_total": total})
    except WebSocketDisconnect:
        pass
    finally:
        # Do NOT await ws.close(); the server stack handles it
        logger.info("/ws/echo-bytes closed; total=%d", total)

# ------------------------------------------------------------------------------
# Main WS: mic PCM16 frames -> Google STT -> interim/final + fast EN translate
# ------------------------------------------------------------------------------
SILENCE_FRAME = b"\x00" * 640      # 20ms of PCM16 @16k mono
KEEPALIVE_GAP_S = 0.75             # if nothing for 750 ms, feed silence

@app.websocket("/ws/translate")
async def ws_translate(ws: WebSocket):
    # Read params once, with sane defaults; never 403 on missing params
    params = dict(ws.query_params)
    role     = (params.get("role")  or "producer").strip()        # "producer" | "viewer"
    src_stt  = (params.get("src")   or "ko-KR").strip()           # STT language (e.g. "en-US")
    dst_tr   = (params.get("dst")   or "en").strip()              # Translate target (e.g. "ko")
    voice    = (params.get("voice") or "en-US-Wavenet-D").strip() # optional; for your TTS

    # Accept the socket
    await ws.accept()
    logger.info("WS connected: role=%s src=%s dst=%s voice=%s", role, src_stt, dst_tr, voice)

    seq = 0
     
    # If this is a viewer, just register and keep the connection open
    if role.lower() == "viewer":
        async with VIEWERS_LOCK:
            VIEWERS.add(ws)
        try:
            # Keep the connection alive; read + ignore any incoming frames
            while True:
                # we don't expect viewer to send bytes; just block until closed
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with VIEWERS_LOCK:
                VIEWERS.discard(ws)
            logger.info("Viewer disconnected")
        return

    # ---------- Producer path (microphone sender) ----------
    q: Deque[bytes] = deque()
    cv = threading.Condition()
    closed = False

    async def feeder():
        nonlocal closed
        try:
            async for data in ws.iter_bytes():
                if data:
                    with cv:
                        q.append(data)
                        cv.notify()
        except (WebSocketDisconnect, CancelledError):
            pass
        finally:
            with cv:
                closed = True
                cv.notify_all()
            logger.info("feeder finished")

    def pcm_iter_sync():
        while True:
            with cv:
                while not q and not closed:
                    cv.wait(timeout=0.1)
                if q:
                    yield q.popleft()
                elif closed:
                    return

    # thread → async queue
    loop = asyncio.get_running_loop()
    stt_out: asyncio.Queue[dict] = asyncio.Queue()

    def stt_worker():
        try:
            # If your stt_streaming_transcripts supports language override,
            # pass it in; else remove language_code=src_stt.
            for msg in stt_streaming_transcripts(
                pcm_iter_sync(),
                # recognizer_id="worship-global",
                # language_code=src_stt,  # uncomment if your function supports it
            ):
                asyncio.run_coroutine_threadsafe(stt_out.put(msg), loop)
        except Exception as e:
            logger.error("STT worker error: %s", e, exc_info=True)
        finally:
            asyncio.run_coroutine_threadsafe(stt_out.put({"type": "__stt_done__"}), loop)

    worker = threading.Thread(target=stt_worker, name="stt-worker", daemon=True)
    worker.start()

    async def stt_consumer():
        nonlocal seq  # <-- ADD THIS LINE
        logger.info("STT supervisor started")
        try:
            src_tr = (src_stt.split("-")[0] or "ko").lower()
            while True:
                msg = await stt_out.get()
                if msg.get("type") == "__stt_done__":
                    break

                if msg["type"] == "interim":
                    # optional: preview the upcoming seq
                    preview_seq = seq + 1
                    payload = {"type": "interim_kr", "text": msg["text"], "seq": preview_seq}
                    await ws.send_json(payload)
                    await broadcast(payload)
                    continue

                # final → commit
                src_text = (msg.get("text") or "").strip()
                if not src_text:
                    continue

                seq += 1                # advance ON COMMIT
                curr = seq              # freeze this value for this sentence

                payload_final = {"type": "final_kr", "text": src_text, "seq": curr}
                await ws.send_json(payload_final)
                await broadcast(payload_final)

                hyb = await match_and_translate(src_text, target_lang=dst_tr or "en")
                dst_text = hyb["text"]; origin = hyb["origin"]; score = round(hyb["score"], 4)

                payload_fast = {
                    "type": "fast_final",
                    "en": dst_text,
                    "from": "google",
                    "dst": dst_tr,
                    "origin": origin,
                    "score": score,
                    "seq": curr,         # same seq as final_kr
                }
                await ws.send_json(payload_fast)
                await broadcast(payload_fast)

        except Exception as e:
            if "timed out after receiving no more client requests" in str(e).lower():
                logger.warning("Streaming aborted: %s", e)
            else:
                logger.exception("STT supervisor error: %s", e)
        finally:
            logger.info("STT supervisor finished")

    feeder_task = asyncio.create_task(feeder())
    consumer_task = asyncio.create_task(stt_consumer())
    done, pending = await asyncio.wait({feeder_task, consumer_task}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    logger.info("WS handler return")

# ------------------------------------------------------------------------------
# Producer: /ws/stt/deepgram
#  - Browser streams PCM → backend → Deepgram
#  - We show partials to producer (for the textarea)
#  - On Deepgram is_final=True, we translate and broadcast to all consumers
# ------------------------------------------------------------------------------
# ---- replace your entire ws_stt_deepgram with this ----
@app.websocket("/ws/stt/deepgram")
async def ws_stt_deepgram(websocket: WebSocket):
    await websocket.accept()
    try:
        dg = await connect_to_deepgram()  # <-- dg is created here
    except Exception as e:
        await websocket.send_json({"type": "error", "message": f"Deepgram connect failed: {e}"})
        await websocket.close()
        return

    seq = 0
    closed = asyncio.Event()

    async def from_client_to_deepgram():
        try:
            while True:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    try:
                        await dg.close()
                    except:
                        pass
                    break
                if (b := msg.get("bytes")):
                    # your AudioWorklet streams raw 16-bit PCM @ 48k
                    await dg.send(b)
                elif (t := msg.get("text")):
                    # allow client-side finalize
                    try:
                        payload = json.loads(t)
                        if payload.get("type") == "finalize":
                            await dg.send(json.dumps({"type": "CloseStream"}))
                    except:
                        pass
        finally:
            closed.set()

    async def from_deepgram_to_server():
        """
        Option A: translate only when a sentence is complete.
        Commit rules:
          - speech_final=True  → commit immediately
          - or final text ends with sentence punctuation → commit
          - else start/refresh a ~1.2s timer; on timeout, commit whatever we have
        """
        SENTENCE_PUNCT = tuple(".?!。？！…")
        COMMIT_WAIT_MS = 1200

        pending_kr: str | None = None
        pending_task: asyncio.Task | None = None

        def ends_like_sentence(t: str) -> bool:
            t = (t or "").rstrip()
            return bool(t) and t[-1] in SENTENCE_PUNCT

        def norm_ws(s: str) -> str:
            return " ".join((s or "").split())

        async def commit_now(kr_text: str):
            nonlocal seq, pending_kr, pending_task
            if not kr_text or not kr_text.strip():
                return
            if norm_ws(kr_text) == norm_ws(getattr(commit_now, "_last_kr", "")):
                return
            setattr(commit_now, "_last_kr", kr_text)

            seq += 1
            src_text = kr_text

            # Hybrid: script match first, else RT translate (using your translate_text_generic under the hood)
            hyb = await match_and_translate(src_text, target_lang="en")
            en = hyb["text"]
            origin = hyb["origin"]
            score = round(hyb["score"], 4)

            print(f"[A][HYBRID] FINAL seq={seq} origin={origin} score={score} "
                f"KR='{src_text}' → EN='{en}'")

            # Back-compatible payloads + origin/score
            live_msg_new = {
                "mode": "live",
                "text": en,
                "seq": seq,
                "src": {"text": src_text, "lang": "ko"},
                "tgt": {"lang": "en"},
                "origin": origin,      # NEW
                "score": score,        # NEW
            }
            live_msg_legacy = {
                "type": "translation",
                "payload": en,
                "lang": "en",
                "meta": {
                    "mode": "realtime",
                    "partial": False,
                    "segment_id": seq,
                    "rev": 0,
                    "seq": seq,
                    "origin": origin,  # NEW
                    "score": score,    # NEW
                },
            }

            try:
                await websocket.send_json(live_msg_new)
                await websocket.send_json(live_msg_legacy)
            except Exception as e:
                print("[DG] send back to producer failed:", e)

            try:
                await manager.broadcast(live_msg_new)
                await manager.broadcast(live_msg_legacy)
                print(f"[BROADCAST] seq={seq} origin={origin} score={score} '{en[:60]}'")
            except Exception as e:
                print("[DG] broadcast error:", e)

            pending_kr = None
            if pending_task and not pending_task.done():
                pending_task.cancel()
            pending_task = None


        async def arm_timer():
            nonlocal pending_task
            if pending_task and not pending_task.done():
                pending_task.cancel()

            async def _wait_and_commit(snap: str):
                try:
                    await asyncio.sleep(COMMIT_WAIT_MS / 1000.0)
                    if pending_kr and norm_ws(pending_kr) == norm_ws(snap):
                        await commit_now(pending_kr)
                except asyncio.CancelledError:
                    pass

            pending_task = asyncio.create_task(_wait_and_commit(pending_kr or ""))

        try:
            async for raw in dg:  # <-- dg is in scope (captured from outer function)
                try:
                    evt = json.loads(raw)
                except Exception:
                    continue
                if evt.get("type") != "Results":
                    continue

                ch = evt.get("channel") or {}
                alts = ch.get("alternatives") or []
                if not alts:
                    continue

                best = alts[0]
                transcript = (best.get("transcript") or "").strip()
                is_final = bool(evt.get("is_final"))
                speech_final = bool(evt.get("speech_final") or False)

                # show partial text in the UI, but DO NOT translate yet
                if transcript and not is_final:
                    try:
                        await websocket.send_json({"type": "stt.partial", "text": transcript})
                    except:
                        pass
                    continue

                if not is_final:
                    continue

                if transcript:
                    pending_kr = transcript

                print(f"[DG][A] final: speech_final={speech_final} KR='{pending_kr or ''}'")

                if speech_final and pending_kr:
                    await commit_now(pending_kr)
                    continue

                if pending_kr and ends_like_sentence(pending_kr):
                    await commit_now(pending_kr)
                    continue

                if pending_kr:
                    await arm_timer()

        finally:
            # best-effort flush on shutdown
            if pending_kr:
                try:
                    await commit_now(pending_kr)
                except Exception:
                    pass

    consumer = asyncio.create_task(from_client_to_deepgram())
    producer = asyncio.create_task(from_deepgram_to_server())
    await closed.wait()
    try:
        consumer.cancel()
        producer.cancel()
    except:
        pass

# ------------------------------------------------------------------------------
# Quick debug to prove the FE consumer is listening
# ------------------------------------------------------------------------------
@app.get("/debug/broadcast")
async def debug_broadcast():
    msg_new = {"mode": "live", "text": "**TEST BROADCAST**", "seq": 999, "tgt": {"lang": "en"}}
    msg_legacy = {
        "type": "translation",
        "payload": "**TEST BROADCAST**",
        "lang": "en",
        "meta": {"mode": "realtime", "partial": False, "segment_id": 999, "rev": 0, "seq": 999},
    }
    await manager.broadcast(msg_new)
    await manager.broadcast(msg_legacy)
    return {"ok": True}

# ==================Google Translation============================

@app.post("/api/translate")
async def translate_endpoint(body: KRIn):
    en = translate_kr_to_en(body.text_kr, use_glossary=True)
    return {"en": en}

# ---- Speech-to-Text (file) ----
@app.post("/api/stt-file")
async def stt_file(audio: UploadFile = File(...)):
    """
    Send a short audio file (wav/flac/ogg/line-in). For live, you'll do streaming via WS.
    """
    data = await audio.read()
    kr = stt_kr_from_bytes_sync(data)
    return {"kr": kr}

# ---- Text-to-Speech ----
class TTSIn(BaseModel):
    text: str
    voice: str | None = "en-US-Wavenet-D"

@app.post("/api/tts")
async def tts_endpoint(body: TTSIn):
    audio = tts_en_to_mp3(body.text, voice_name=body.voice or "en-US-Wavenet-D")
    return StreamingResponse(iter([audio]), media_type="audio/mpeg")

# ---- Utilities ----
@app.get("/api/tts/voices")
async def voices():
    return {"en": list_voices("en-")}

# queue is working?