# backend/app/services/google_services.py
from __future__ import annotations

import os, logging
from pathlib import Path
from typing import Iterable, Generator, Optional

from dotenv import load_dotenv
from google.cloud import speech_v2, translate_v3, texttospeech
from google.api_core.exceptions import Aborted, NotFound, InvalidArgument
from google.api_core import exceptions

# ---- Load backend/.env explicitly ----
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(dotenv_path=str(ENV_PATH), override=True)

# ---- Constants (adjust if needed) ----
LANG_CODE = "ko-KR"
SAMPLE_RATE_HZ = 16000
MODEL_ID = "latest_long"
DEFAULT_RECOGNIZER_ID = "worship-global"   # your created global recognizer

_glossary_warned: bool = False
# ---- Client singletons ----
_translate_client: Optional[translate_v3.TranslationServiceClient] = None
_tts_client: Optional[texttospeech.TextToSpeechClient] = None
_speech_client: Optional[speech_v2.SpeechClient] = None


# =========================
# Env / Resource helpers
# =========================
def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var {name}. Put it in backend/.env (needed: {name}).")
    return v

def _parent_loc() -> str:
    """Regional parent for Translate (v3)."""
    project = _require_env("GCP_PROJECT")
    location = os.getenv("GCP_LOCATION", "us-central1")
    return f"projects/{project}/locations/{location}"

def _speech_parent_global() -> str:
    """Global location parent for Speech v2 Recognizers."""
    return f"projects/{_require_env('GCP_PROJECT')}/locations/global"

def _recognizer_path(recognizer_id: Optional[str] = None) -> str:
    """Global recognizer path; defaults to your named recognizer."""
    rid = recognizer_id or DEFAULT_RECOGNIZER_ID
    return f"{_speech_parent_global()}/recognizers/{rid}"

def _glossary_id() -> str:
    return os.getenv("GOOGLE_TRANSLATE_GLOSSARY_ID", "")


# =========================
# Translate (v3)
# =========================
def translate_text_generic(
    text: str,
    source_lang: str,       # e.g., "en", "ko"
    target_lang: str,       # e.g., "ko", "en"
    use_glossary_if_en: bool = True,
) -> str:
    if not text:
        return ""

    global _translate_client, _glossary_warned
    _translate_client = _translate_client or translate_v3.TranslationServiceClient()

    parent = _parent_loc()  # projects/.../locations/us-central1 (or your region)
    req = {
        "parent": parent,
        "contents": [text],
        "mime_type": "text/plain",
        "source_language_code": source_lang,
        "target_language_code": target_lang,
    }

    glossary = _glossary_id()
    want_glossary = (use_glossary_if_en and target_lang.lower().startswith("en") and bool(glossary))
    if want_glossary:
        req["glossary_config"] = {"glossary": f"{parent}/glossaries/{glossary}"}

    try:
        resp = _translate_client.translate_text(request=req)
        if getattr(resp, "glossary_translations", None):
            return resp.glossary_translations[0].translated_text
        return resp.translations[0].translated_text
    except (NotFound, InvalidArgument):
        if want_glossary and not _glossary_warned:
            logging.error("Translate glossary not available; falling back (glossary=%r parent=%r)", glossary, parent)
            _glossary_warned = True
        # retry without glossary
        req.pop("glossary_config", None)
        resp = _translate_client.translate_text(request=req)
        return resp.translations[0].translated_text
    
def translate_kr_to_en(text: str, use_glossary: bool = True) -> str:
    """
    Translate ko->en. If a glossary is configured but not found or invalid,
    log a warning only once and transparently retry without glossary.
    """
    if not text:
        return ""

    global _translate_client, _glossary_warned
    _translate_client = _translate_client or translate_v3.TranslationServiceClient()

    parent = _parent_loc()  # e.g., projects/<id>/locations/us-central1
    req = {
        "parent": parent,
        "contents": [text],
        "mime_type": "text/plain",
        "source_language_code": "ko",
        "target_language_code": "en",
    }

    glossary = _glossary_id()
    want_glossary = bool(use_glossary and glossary)

    if want_glossary:
        req["glossary_config"] = {"glossary": f"{parent}/glossaries/{glossary}"}

    # First attempt (maybe with glossary)
    try:
        resp = _translate_client.translate_text(request=req)
        if getattr(resp, "glossary_translations", None):
            return resp.glossary_translations[0].translated_text
        return resp.translations[0].translated_text

    except (NotFound, InvalidArgument) as e:
        # Glossary missing / wrong location / invalid name → warn once and retry without glossary
        if want_glossary and not _glossary_warned:
            logging.error("Translate glossary error (%s). Falling back without glossary. "
                          "GOOGLE_TRANSLATE_GLOSSARY_ID='%s', parent='%s'",
                          e.__class__.__name__, glossary, parent)
            _glossary_warned = True

        # Retry without glossary
        try:
            req.pop("glossary_config", None)
            resp = _translate_client.translate_text(request=req)
            return resp.translations[0].translated_text
        except Exception:
            # Re-raise original glossary error for clarity if fallback also fails
            raise

    except Exception:
        # Any other error: surface it
        raise

# =========================
# Text-to-Speech
# =========================
def tts_en_to_mp3(text: str, voice_name: str = "en-US-Wavenet-D") -> bytes:
    global _tts_client
    if _tts_client is None:
        _tts_client = texttospeech.TextToSpeechClient()

    input_ = texttospeech.SynthesisInput(text=text)
    parts = voice_name.split("-")
    lang = "-".join(parts[:2]) if len(parts) >= 2 else "en-US"
    voice = texttospeech.VoiceSelectionParams(language_code=lang, name=voice_name)
    audio = texttospeech.AudioConfig(audio_encoding=texttospeech.AudioEncoding.MP3)
    resp = _tts_client.synthesize_speech(input=input_, voice=voice, audio_config=audio)
    return resp.audio_content

def list_voices(prefix: str = "en-") -> list[str]:
    global _tts_client
    if _tts_client is None:
        _tts_client = texttospeech.TextToSpeechClient()
    voices = _tts_client.list_voices().voices
    return sorted(v.name for v in voices if v.name.startswith(prefix))


# =========================
# Speech-to-Text (v2)
# =========================
def _speech() -> speech_v2.SpeechClient:
    global _speech_client
    if _speech_client is None:
        _speech_client = speech_v2.SpeechClient()
    return _speech_client

def ensure_global_recognizer(recognizer_id: str = DEFAULT_RECOGNIZER_ID) -> str:
    """
    Ensure a recognizer exists in 'global'. Returns full name.
    Requires roles/speech.admin (Owner includes it). Call once at startup / admin path.
    """
    cli = _speech()
    parent = _speech_parent_global()
    name = f"{parent}/recognizers/{recognizer_id}"

    try:
        cli.get_recognizer(name=name)
        return name
    except Exception:
        pass

    recognizer = speech_v2.Recognizer(
        default_recognition_config=speech_v2.RecognitionConfig(
            language_codes=[LANG_CODE],
            model=MODEL_ID,
            features=speech_v2.RecognitionFeatures(
                enable_automatic_punctuation=True
            ),
            explicit_decoding_config=speech_v2.ExplicitDecodingConfig(
                encoding=speech_v2.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=SAMPLE_RATE_HZ,
                audio_channel_count=1,
            ),
        )
    )
    op = cli.create_recognizer(parent=parent, recognizer=recognizer, recognizer_id=recognizer_id)
    op.result()  # wait for creation
    return name

# --- Sync (small files) ---
def stt_kr_from_bytes_sync(content_bytes: bytes, recognizer_id: Optional[str] = None) -> str:
    cli = _speech()
    config = speech_v2.RecognitionConfig(
        explicit_decoding_config=speech_v2.ExplicitDecodingConfig(
            encoding=speech_v2.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=SAMPLE_RATE_HZ,
            audio_channel_count=1,
        ),
        language_codes=[LANG_CODE],
        model=MODEL_ID,
        features=speech_v2.RecognitionFeatures(enable_automatic_punctuation=True),
    )
    req = speech_v2.RecognizeRequest(
        recognizer=_recognizer_path(recognizer_id),
        config=config,
        content=content_bytes,
    )
    resp = cli.recognize(request=req)
    return " ".join(alt.transcript for r in resp.results for alt in r.alternatives)

# --- Streaming ---
def stt_streaming_request_generator(
    pcm16_chunks: Iterable[bytes],
    recognizer_id: Optional[str] = None,
    src_lang: str = "ko-KR",               # <-- NEW
) -> Generator[speech_v2.StreamingRecognizeRequest, None, None]:
    recognizer = _recognizer_path() if recognizer_id is None else f"{_speech_parent_global()}/recognizers/{recognizer_id}"

    streaming_config = speech_v2.StreamingRecognitionConfig(
        config=speech_v2.RecognitionConfig(
            explicit_decoding_config=speech_v2.ExplicitDecodingConfig(
                encoding=speech_v2.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=16000,
                audio_channel_count=1,
            ),
            language_codes=[src_lang],     # <-- use caller’s language
            model="latest_long",
            features=speech_v2.RecognitionFeatures(enable_automatic_punctuation=True),
        ),
        streaming_features=speech_v2.StreamingRecognitionFeatures(interim_results=True),
    )

    yield speech_v2.StreamingRecognizeRequest(recognizer=recognizer, streaming_config=streaming_config)
    for chunk in pcm16_chunks:
        if not chunk:
            continue
        yield speech_v2.StreamingRecognizeRequest(recognizer=recognizer, audio=chunk)


def stt_streaming_transcripts(
    pcm16_chunks: Iterable[bytes],
    recognizer_id: Optional[str] = None,
    src_lang: str = "ko-KR",               # <-- NEW
) -> Iterable[dict]:
    global _speech_client
    if _speech_client is None:
        _speech_client = speech_v2.SpeechClient()

    responses = _speech_client.streaming_recognize(
        requests=stt_streaming_request_generator(pcm16_chunks, recognizer_id, src_lang=src_lang)
    )
    for resp in responses:
        for result in resp.results:
            if not result.alternatives:
                continue
            alt = result.alternatives[0]
            yield {
                "type": "final" if result.is_final else "interim",
                "text": alt.transcript,
                "stability": getattr(result, "stability", 0.0),
            }

# =========================
# Debug helpers
# =========================
def debug_log_speech_paths() -> None:
    print("GOOGLE_APPLICATION_CREDENTIALS:", os.getenv("GOOGLE_APPLICATION_CREDENTIALS"))
    print("GCP_PROJECT:", os.getenv("GCP_PROJECT"))
    print("GCP_LOCATION:", os.getenv("GCP_LOCATION"))
    print("Speech v2 recognizer path:", _recognizer_path())
