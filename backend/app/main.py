from __future__ import annotations

import os
import json
import asyncio
import logging
import pathlib
import threading, time
from typing import Deque, Iterable, Optional
from collections import deque

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File  # <-- FIXED
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from asyncio import CancelledError
from typing import Set
from starlette.websockets import WebSocketState

# Local modules
from app.socket_manager import manager
from app.deepgram_session import connect_to_deepgram
from app.utils.translate import translate_text
from app.routes import translate as translate_routes
from app.services.google_services import (
    stt_kr_from_bytes_sync,
    translate_kr_to_en,
    tts_en_to_mp3,
    list_voices,
    stt_streaming_transcripts,
    debug_log_speech_paths,
    ensure_global_recognizer,
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
creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or ""
if not creds_path or not os.path.exists(creds_path):
    raise RuntimeError(f"Creds file not found at {creds_path}. Fix backend/.env or path.")

# ------------------------------------------------------------------------------
# FastAPI setup
# ------------------------------------------------------------------------------
app = FastAPI(title="Real-Time Translation Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # relax for dev; tighten for prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keep your existing HTTP routes under /api
app.include_router(translate_routes.router, prefix="/api")

VIEWERS: Set[WebSocket] = set()

async def broadcast(payload: dict):
    dead = []
    for v in list(VIEWERS):
        try:
            await v.send_json(payload)
        except Exception:
            dead.append(v)
    for v in dead:
        try:
            VIEWERS.remove(v)
        except KeyError:
            pass

# Simple root for liveness
@app.get("/")
def root():
    return {"ok": True, "msg": "server is live"}

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
    # role=viewer || producer (default producer)
    role = (ws.query_params.get("role") or "producer").lower()

    # VIEWER: just register, keep connection alive, and exit when closed
    if role == "viewer":
        await ws.accept()
        logger.info("Viewer connected")
        VIEWERS.add(ws)
        try:
            # keep alive until client closes; no STT, no audio expected
            while True:
                # optional: ping/pong or small sleep
                if ws.application_state == WebSocketState.DISCONNECTED:
                    break
                await asyncio.sleep(30)
        except Exception:
            pass
        finally:
            VIEWERS.discard(ws)
            logger.info("Viewer disconnected")
        return

    # PRODUCER flow (your current code, plus broadcast calls)
    await ws.accept()
    logger.info("WS client connected")

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

    # thread worker → async queue
    loop = asyncio.get_running_loop()
    stt_out: asyncio.Queue[dict] = asyncio.Queue()

    def stt_worker():
        try:
            for msg in stt_streaming_transcripts(pcm_iter_sync()):
                asyncio.run_coroutine_threadsafe(stt_out.put(msg), loop)
        except Exception as e:
            logger.error("STT worker error: %s", e, exc_info=True)
        finally:
            asyncio.run_coroutine_threadsafe(stt_out.put({"type": "__stt_done__"}), loop)

    worker = threading.Thread(target=stt_worker, name="stt-worker", daemon=True)
    worker.start()

    async def stt_consumer():
        logger.info("STT supervisor started")
        try:
            while True:
                msg = await stt_out.get()
                if msg.get("type") == "__stt_done__": break

                if msg["type"] == "interim":
                    payload = {"type": "interim_kr", "text": msg["text"]}
                    await ws.send_json(payload)
                    await broadcast(payload)
                else:
                    kr = (msg["text"] or "").strip()
                    payload_final = {"type": "final_kr", "text": kr}
                    await ws.send_json(payload_final)
                    await broadcast(payload_final)

                    en = translate_kr_to_en(kr, use_glossary=True)
                    payload_fast = {"type": "fast_final", "en": en, "from": "google"}
                    await ws.send_json(payload_fast)
                    await broadcast(payload_fast)

        except Exception as e:
            if "timed out after receiving no more client requests" in str(e).lower():
                logger.warning("Streaming aborted: %s", e)
            else:
                logger.exception("STT supervisor error: %s", e)
        finally:
            logger.info("STT supervisor finished")

    feeder_task   = asyncio.create_task(feeder())
    consumer_task = asyncio.create_task(stt_consumer())
    done, pending = await asyncio.wait({feeder_task, consumer_task}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending: t.cancel()
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
            # de-dup repeated finals
            if norm_ws(kr_text) == norm_ws(getattr(commit_now, "_last_kr", "")):
                return
            setattr(commit_now, "_last_kr", kr_text)

            seq += 1
            src_text = kr_text
            try:
                en = await translate_text(src_text, "ko", "en")
            except Exception as e:
                print("[TX] error:", e)
                en = src_text  # fail-open

            print(f"[A] FINAL seq={seq} KR='{src_text}' → EN='{en}'")

            # shape your client already supports
            live_msg_new = {
                "mode": "live",
                "text": en,
                "seq": seq,
                "src": {"text": src_text, "lang": "ko"},
                "tgt": {"lang": "en"},
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
                print(f"[BROADCAST] seq={seq} '{en[:60]}'")
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