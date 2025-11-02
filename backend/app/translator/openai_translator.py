"""Legacy compatibility wrapper for chunk-sized translations.

Historically this module called OpenAI's Chat Completions API. To comply with the
new requirement of using Google products end-to-end, the helper now proxies to
`translate_text_generic`, the same Google Cloud Translate v3 path we use for
script matching fallbacks.
"""

from __future__ import annotations

import asyncio

from app.services.google_services import translate_text_generic


async def translate_ko_to_en_chunk(ko: str) -> str:
    """Translate a short Korean fragment to English via Google Cloud."""
    text = (ko or "").strip()
    if not text:
        return ""

    loop = asyncio.get_running_loop()

    def _translate_sync() -> str:
        return translate_text_generic(
            text=text,
            source_lang="ko",
            target_lang="en",
        )

    try:
        return await loop.run_in_executor(None, _translate_sync)
    except Exception as exc:
        # Fail open to keep the WS pipeline moving; logs show the root cause.
        print(f"[TX][chunk] Google translate error: {exc}")
        return text
