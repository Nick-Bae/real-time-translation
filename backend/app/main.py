from __future__ import annotations

import os
import json
import asyncio
import logging
import pathlib
import queue
import threading, time
from typing import Deque, Iterable, Optional
from collections import deque
import google.auth
from google.oauth2 import service_account

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Request, HTTPException, Body, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
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
from app.segmentation import ClauseCommitter, CommitConfig
from app.utils.translate import translate_text
from app.routes import translate as translate_routes
from app.routes import hybrid as hybrid_routes
from app.hybrid_store import match_and_translate 
from app.segmentation import _trim_after_connective
from app.services.google_services import (
    stt_kr_from_bytes_sync,
    translate_kr_to_en,
    tts_en_to_mp3,
    list_voices,
    stt_streaming_transcripts,
    debug_log_speech_paths,
    ensure_global_recognizer,
    translate_text_generic
)


# ---- Optional: existing routers
from app.routes import translate as translate_routes  # keeps your /api endpoints

class TranslateReq(BaseModel):
    text: str = Field(..., description="Text to translate")
    src: str = Field(..., description="Source BCP-47 or ISO code, e.g. 'ko'")
    dst: str = Field(..., description="Target code, e.g. 'en'")

class TranslateRes(BaseModel):
    text: str  # translated text

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
    SENTINEL = object()
    pcm_queue: "queue.Queue[bytes | object]" = queue.Queue(maxsize=64)  # small backpressure
    closed = False

    async def feeder():
        nonlocal closed
        try:
            async for data in ws.iter_bytes():
                if not data:
                    continue
                try:
                    pcm_queue.put_nowait(data)
                except queue.Full:
                    # drop oldest frame to keep real-time
                    try:
                        _ = pcm_queue.get_nowait()
                    except queue.Empty:
                        pass
                    pcm_queue.put_nowait(data)
        except (WebSocketDisconnect, CancelledError):
            pass
        finally:
            closed = True
            try:
                pcm_queue.put_nowait(SENTINEL)
            except queue.Full:
                pass
            logger.info("feeder finished")

    def pcm_iter_sync():
        """Fresh, blocking iterator over queue; one instance per STT window."""
        while True:
            try:
                item = pcm_queue.get(timeout=0.2)
            except queue.Empty:
                if closed:
                    return
                continue
            if item is SENTINEL:
                return
            yield item  # bytes


    # thread → async queue
    loop = asyncio.get_running_loop()
    stt_out: asyncio.Queue[dict] = asyncio.Queue()

    def stt_worker():
        min_delay = 0.5
        max_delay = 8.0
        attempts = 0
        try:
            while True:
                if closed:
                    break
                try:
                    # PASS A CALLABLE, NOT pcm_iter_sync()
                    for msg in stt_streaming_transcripts(
                        pcm_source=pcm_iter_sync,   # <-- ✅ factory
                        src_lang=src_stt,
                    ):
                        asyncio.run_coroutine_threadsafe(stt_out.put(msg), loop)
                    break  # normal end
                except Exception as e:
                    emsg = str(e)
                    logger.error("STT window error: %s", emsg)
                    if closed:
                        break
                    attempts += 1
                    delay = min(max_delay, min_delay * (2 ** (attempts - 1)))
                    logger.warning("Restarting STT window in %.1fs (attempt %d)", delay, attempts)
                    time.sleep(delay)
                    continue
        except Exception as e:
            logger.exception("STT worker fatal error: %s", e)
        finally:
            asyncio.run_coroutine_threadsafe(stt_out.put({"type": "__stt_done__"}), loop)


    worker = threading.Thread(target=stt_worker, name="stt-worker", daemon=True)
    worker.start()

    async def stt_consumer():
        nonlocal seq
        logger.info("STT supervisor started")


        # --- per-utterance state ---
        pending_interim: Optional[str] = None
        commit_used = False
        sent_fast_final = False  # ensure at most one fast_final per utterance
        recent_commit_text = ""   # last KO clause we committed (for replace/variant)
        recent_commit_time = 0.0  # when we sent it (optional)

        # --- knobs (tune these) ---
        COALESCE_MS = 180
        MIN_COMMIT_TOKENS = 2
        MIN_COMMIT_CHARS  = 10
        DEDUP_WINDOW_S    = 4.0

        # connective tails we should NOT emit alone
        # Replace your old CONNECTIVE_TAIL with this:
        # block ONLY if the text ends with an incomplete connective (no trailing content/punct)
        CONNECTIVE_TAIL = re.compile(
            r"(?:"
            r"기\s*때(?:문|문에?)|"  # 기 때문에 / 기 때문…
            r"때(?:문|문에?)|"       # 때문에 / 때문…
            r"(?:으)?니|[아어]서|라서|"
            r"(?:으)?면|다면|"
            r"는?데|지(?:만)?|"
            r"면서|다가|자마자|거나|거든|"
            r"며|으며|"
            r"(?:했|하|되(?:었)?|해)\s*기"
            r")$"
        )


        recent_ko: dict[str, float] = {}

        ko_committed_prefix: str = ""

        def _tail_after_commits(full: str, committed_prefix: str) -> str:
            """
            Remove the already-spoken KO prefix (tracked via commits) from the latest final text.
            Returns the remaining tail; if no prefix matches, returns the normalized full string.
            """
            if not full:
                return ""
            f = _norm(full)
            if not committed_prefix:
                return f
            prefix = _norm(committed_prefix)
            if prefix and f.startswith(prefix):
                return _norm(f[len(prefix):])
            core_prefix = prefix.rstrip(" .,!?:;…‥、。！？」］)}]“”‘’'\"")
            if core_prefix and f.startswith(core_prefix):
                return _norm(f[len(core_prefix):])
            return f

        def _norm(s: str) -> str:
            return re.sub(r"\s+", " ", (s or "")).strip()

        def _tok_count(s: str) -> int:
            return len([t for t in _norm(s).split(" ") if t])

        def ko_seen_recent(s: str) -> bool:
            now = time.time()
            # prune
            for k, t in list(recent_ko.items()):
                if now - t > DEDUP_WINDOW_S:
                    recent_ko.pop(k, None)
            hit = s in recent_ko and (now - recent_ko[s]) <= DEDUP_WINDOW_S
            if not hit:
                recent_ko[s] = now
            return hit

        src_tr = (src_stt.split("-")[0] or "ko").lower()
        committer = ClauseCommitter(
            CommitConfig(
                max_elapsed_s=12.0,
                max_chars=42,
                commit_on_tail_ender=True,
                commit_on_tail_marker=True,     # keep ON; coalescer smooths it
                allow_internal_marker_split=True,
                translate_on_server=False,
            ),
            lang=src_tr,
        )

        # --- coalescer ---
        pending_commit: Optional[str] = None
        commit_task: Optional[asyncio.Task] = None


        # --- helpers (place near other utils) ---
        _WS = re.compile(r"\s+")
        def norm_ws(s: str) -> str:
            return _WS.sub(" ", (s or "")).strip()

        def tok_norm(s: str) -> list[str]:
            s = re.sub(r"[^\w가-힣\s]", " ", s or "")
            s = re.sub(r"\s+", " ", s).strip()
            return s.split()

        def is_variant(old: str, new: str) -> bool:
            """Treat as same clause if one mostly contains the other."""
            o, n = " ".join(tok_norm(old)), " ".join(tok_norm(new))
            if not o or not n:
                return False
            if o in n or n in o:
                return True
            so, sn = set(o.split()), set(n.split())
            # high overlap = variant
            j = len(so & sn) / max(1, len(so | sn))
            return j >= 0.8

        

        # put this near your other constants/helpers
        DEDUP_WINDOW_S = 3.0
        TRAIL_PUNCT = " .,!?:;…‥、。！？」］)}]“”‘’'\""

        def strip_trail_punct(s: str) -> str:
            i = len(s)
            while i > 0 and s[i-1] in TRAIL_PUNCT:
                i -= 1
            return s[:i]

        async def send_commit_now(websocket, manager, dst_tr: str, ko_text: str) -> bool:
            nonlocal recent_commit_text, recent_commit_time, ko_committed_prefix, commit_used  # <— important
            txt = norm_ws(ko_text)
            if not txt:
                return False

            send_txt = txt
            tail_only = False
            if ko_committed_prefix:
                tail_candidate = _tail_after_commits(txt, ko_committed_prefix)
                if tail_candidate != txt:
                    send_txt = tail_candidate
                    tail_only = True
                else:
                    base_prefix = strip_trail_punct(norm_ws(ko_committed_prefix))
                    send_norm = norm_ws(txt)
                    if base_prefix and send_norm.startswith(base_prefix):
                        remainder = send_norm[len(base_prefix):].lstrip(" ,")
                        if remainder:
                            send_txt = remainder
                            tail_only = True
            if not send_txt:
                return False

            if tail_only:
                if _tok_count(send_txt) < MIN_COMMIT_TOKENS or len(send_txt) < MIN_COMMIT_CHARS:
                    return False

            if _tok_count(send_txt) < MIN_COMMIT_TOKENS or len(send_txt) < MIN_COMMIT_CHARS:
                if ko_committed_prefix:
                    return False

            now = time.time()

            # exact dup guard
            if recent_commit_text and norm_ws(recent_commit_text) == send_txt and (now - recent_commit_time) < 3.0:
                return False

            base_txt = strip_trail_punct(send_txt)
            if base_txt.endswith("기") and len(base_txt) > 1:
                # wait for the connective tail (e.g., “…기 때문에”)
                return False

            # replace if current grows the previous (prefix growth)
            def _strip_trail_punct(s: str) -> str:
                TRAIL = " .,!?:;…‥、。！？」］)}]“”‘’'\""
                i = len(s)
                while i > 0 and s[i-1] in TRAIL:
                    i -= 1
                return s[:i]

            replace = False
            if not tail_only and recent_commit_text:
                prev_norm = norm_ws(recent_commit_text)
                prev_base = strip_trail_punct(prev_norm)
                if send_txt.startswith(prev_base) and len(send_txt) > len(prev_norm):
                    replace = True
                elif is_variant(prev_norm, send_txt):
                    replace = True

            recent_commit_text = send_txt
            recent_commit_time = now

            payload = {
                "type": "commit",
                "payload": send_txt,
                "src": "ko",
                "dst": dst_tr,
                "replace": replace,
                "ts_ms": int(now * 1000),
            }

            try:
                await websocket.send_json(payload)
            except Exception as e:
                print("[producer] send commit failed:", e)
            try:
                await manager.broadcast(payload)
            except Exception as e:
                print("[broadcast] commit failed:", e)

            # Update the committed KO prefix so finals can skip already-spoken clauses
            if replace:
                ko_committed_prefix = send_txt
            else:
                if ko_committed_prefix:
                    base = strip_trail_punct(ko_committed_prefix)
                    ko_committed_prefix = norm_ws(f"{base} {send_txt}")
                else:
                    ko_committed_prefix = send_txt

            # Mark that we used a commit in this utterance
            commit_used = True
            return True

        
                
        async def schedule_commit(ko_text: str):
            nonlocal pending_commit, commit_task

            # normalize
            txt = norm_ws(ko_text or "")
            if not txt:
                return

            # If we have “…기 때문에 … / …지만 … / …는데 …” followed by a new clause,
            # keep only the left up to the connective for this early commit.
            # (_trim_after_connective should return (left, right))
            try:
                trimmed, _ = _trim_after_connective(txt, "")
                txt = trimmed or txt
            except NameError:
                # If you haven't added _trim_after_connective yet, just skip trimming.
                pass

            # Guards for non-final early commits
            if _tok_count(txt) < MIN_COMMIT_TOKENS or len(txt) < MIN_COMMIT_CHARS:
                return
            # Block only hanging connective tails like “…기 때문에”, “…지만”, “…는데” with nothing after
            if CONNECTIVE_TAIL.search(strip_trail_punct(txt)):
                if _tok_count(txt) <= MIN_COMMIT_TOKENS:
                    return

            # Coalesce: replace any pending commit with the latest snapshot
            snap = txt
            pending_commit = snap

            # Cancel any previous delayed send for the old snapshot
            if commit_task and not commit_task.done():
                commit_task.cancel()

            async def _wait_then_send(expected: str):
                try:
                    await asyncio.sleep(COALESCE_MS / 1000.0)
                    # Only send if nothing newer arrived
                    if pending_commit == expected:
                        # NEW: use the unified helper signature (ws, manager, dst_tr, text)
                        await send_commit_now(ws, manager, dst_tr, expected)
                except asyncio.CancelledError:
                    # Newer text arrived or stream rolled over
                    pass

            commit_task = asyncio.create_task(_wait_then_send(snap))



        async def flush_pending_commit():
            nonlocal pending_commit, commit_task
            if commit_task and not commit_task.done():
                commit_task.cancel()
            snap = norm_ws(pending_commit or "")
            pending_commit = None
            if snap:
                await send_commit_now(ws, manager, dst_tr, snap)

        try:
            while True:
                msg = await stt_out.get()
                t = msg.get("type")

                if t == "__stt_done__":
                    # Flush both the committer and coalescer, then finish
                    flushed = committer.force_flush()
                    if flushed:
                        await flush_pending_commit()
                        await send_commit_now(ws, manager, dst_tr, flushed)
                    else:
                        await flush_pending_commit()

                    # Reset per-utterance state before exit (belt & suspenders)
                    ko_committed_prefix = ""
                    recent_commit_text = ""
                    recent_commit_time = 0.0
                    pending_interim = None
                    try:
                        committer.reset_for_new_utterance()
                    except AttributeError:
                        pass

                    break

                elif t == "__stt_rollover__":
                    # Utterance boundary; flush remainder
                    flushed = committer.force_flush()
                    if flushed:
                        await flush_pending_commit()
                        await send_commit_now(ws, manager, dst_tr, flushed)
                    else:
                        await flush_pending_commit()

                    # Reset per-utterance replace/variant memory
                    recent_commit_text = ""
                    recent_commit_time = 0.0

                    # Only emit source final here (NO fast_final on rollover)
                    if pending_interim and pending_interim.strip():
                        src_text = pending_interim.strip()
                        tail = _tail_after_commits(src_text, ko_committed_prefix)
                        if tail:
                            seq += 1
                            await ws.send_json({"type": "final_kr", "text": tail, "seq": seq})
                            await broadcast({"type": "final_kr", "text": tail, "seq": seq})

                    # Reset backend committer for the next utterance
                    try:
                        committer.reset_for_new_utterance()  # ⬅️ good if implemented
                    except AttributeError:
                        pass

                    # Reset local flags
                    pending_interim = None
                    ko_committed_prefix = ""
                    commit_used = False
                    sent_fast_final = False
                    continue


                elif t == "__speech_activity_end__":
                    # end of speech → flush immediately (but do NOT reset utterance state here)
                    flushed = committer.force_flush()
                    if flushed:
                        await flush_pending_commit()
                        await send_commit_now(ws, manager, dst_tr, flushed)
                    else:
                        await flush_pending_commit()

                elif t == "interim":
                    pending_interim = msg.get("text", "") or ""
                    # mirror interim
                    payload = {"type": "interim_kr", "text": pending_interim}
                    await ws.send_json(payload)
                    await broadcast(payload)

                    # eager commit (coalesced)
                    c = committer.feed(pending_interim)
                    if c:
                        await schedule_commit(c)
                    continue

                elif t == "final":
                    src_text = (msg.get("text") or "").strip()

                    # flush remainder first
                    flushed = committer.force_flush()
                    if flushed:
                        await flush_pending_commit()
                        await send_commit_now(ws, manager, dst_tr, flushed)
                    else:
                        await flush_pending_commit()

                    if src_text:
                        # compute only the part that was NOT already spoken
                        tail = _tail_after_commits(src_text, ko_committed_prefix)

                        if tail:
                            seq += 1
                            curr = seq
                            pending_interim = None

                            # send source final **as the tail only**
                            await ws.send_json({"type": "final_kr", "text": tail, "seq": curr})
                            await broadcast({"type": "final_kr", "text": tail, "seq": curr})
                        else:
                            # nothing new to say; still bump seq to keep order if you want
                            pass

                        # If NO commit went out for this utterance, allow ONE fast_final here (preview only)
                        if not commit_used and not sent_fast_final:
                            hyb = await match_and_translate(src_text, target_lang=dst_tr or "en")
                            dst_text = hyb["text"]; origin = hyb["origin"]; score = round(hyb["score"], 4)
                            fast = {
                                "type": "fast_final", "en": dst_text, "from": "google", "dst": dst_tr,
                                "origin": origin, "score": score, "seq": curr
                            }
                            await ws.send_json(fast)
                            await broadcast(fast)
                            await broadcast({
                                "mode": "live", "text": dst_text, "seq": curr,
                                "src": {"text": src_text, "lang": src_tr},
                                "tgt": {"lang": dst_tr}, "origin": origin, "score": score,
                            })
                            sent_fast_final = True

                    # reset for next utterance
                    ko_committed_prefix = ""
                    commit_used = False
                    sent_fast_final = False
                    continue


        except Exception as e:
            if "timed out after receiving no more client requests" in str(e).lower():
                logger.warning("Streaming aborted: %s", e)
            else:
                logger.exception("STT supervisor error: %s", e)
        finally:
            # just in case
            await flush_pending_commit()
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

@app.post("/api/translate", response_model=TranslateRes)
async def translate_endpoint(body: TranslateReq):
    try:
        out = translate_text_generic(
            text=body.text, source_lang=body.src, target_lang=body.dst
        )
        return {"text": out}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"translate failed: {e}")

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
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Content-Length": str(len(audio)), "Cache-Control": "no-store"},
    )
    
# ---- Utilities ----
@app.get("/api/tts/voices")
async def voices():
    return {"en": list_voices("en-")}

# queue is working?
