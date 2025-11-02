# backend/app/utils/translate.py
from __future__ import annotations

import asyncio
from typing import Dict

from app.services.google_services import translate_text_generic

_LANG_ALIASES: Dict[str, str] = {
    "korean": "ko",
    "ko": "ko",
    "ko-kr": "ko",
    "english": "en",
    "en": "en",
    "en-us": "en",
    "chinese": "zh",
    "zh": "zh",
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
    "mandarin": "zh",
    "cantonese": "yue",
    "spanish": "es",
    "es": "es",
    "japanese": "ja",
    "ja": "ja",
    "french": "fr",
    "fr": "fr",
    "vietnamese": "vi",
    "vi": "vi",
}

def _normalize_lang_code(raw: str | None, fallback: str) -> str:
    if not raw:
        return fallback
    value = raw.strip()
    if not value:
        return fallback
    key = value.lower().replace("_", "-")
    if key in _LANG_ALIASES:
        return _LANG_ALIASES[key]
    # Allow BCP-47 codes such as en-US. Google Translate v3 accepts them.
    if "-" in key:
        parts = [p for p in key.split("-") if p]
        if not parts:
            return fallback
        primary = parts[0]
        if len(primary) == 2 and primary.isalpha():
            return "-".join([primary] + parts[1:])
    if len(key) == 2 and key.isalpha():
        return key
    return fallback

async def translate_text(text: str, source: str, target: str) -> str:
    """Translate using Google Cloud. Fails open on unexpected errors."""
    clean = (text or "").strip()
    if not clean:
        return ""

    src = _normalize_lang_code(source, "ko")
    dst = _normalize_lang_code(target, "en")

    loop = asyncio.get_running_loop()

    def _translate_sync() -> str:
        return translate_text_generic(
            text=clean,
            source_lang=src,
            target_lang=dst,
        )

    try:
        return await loop.run_in_executor(None, _translate_sync)
    except Exception as e:
        print(f"[TX] Google translate error: {e}")
        return clean
