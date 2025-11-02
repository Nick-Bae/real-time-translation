# backend/app/utils/google_translate.py
from google.cloud import translate_v2 as translate

_client = None

def _client_singleton():
    global _client
    if _client is None:
        _client = translate.Client()
    return _client

def google_translate(text: str, source: str = "ko", target: str = "en") -> str:
    if not text.strip():
        return ""
    client = _client_singleton()
    res = client.translate(
        text,
        source_language=source,
        target_language=target,
        format_="text",  # ensure plain-text output (no HTML entities)
    )
    return res["translatedText"]
