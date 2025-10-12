# backend/app/services/gcp_translation.py
from __future__ import annotations
import os
import re
from typing import Optional, List
from google.cloud import translate_v3 as translate

PROJECT_ID = os.getenv("GCP_PROJECT_ID")
LOCATION = os.getenv("GCP_LOCATION", "us-central1")
GLOSSARY_ID = os.getenv("GCP_TRANSLATION_GLOSSARY_ID")
PARENT = f"projects/{PROJECT_ID}/locations/{LOCATION}"

_translation_client: Optional[translate.TranslationServiceClient] = None

def _client() -> translate.TranslationServiceClient:
    global _translation_client
    if _translation_client is None:
        _translation_client = translate.TranslationServiceClient()
    return _translation_client

def translate_ko_en_fast(
    text: str,
    use_glossary: bool = True,
) -> str:
    """
    Fast path for live captioning: ko -> en using NMT with optional Glossary.
    """
    if not text:
        return ""

    req_kwargs = dict(
        parent=PARENT,
        contents=[text],
        source_language_code="ko",
        target_language_code="en",
        mime_type="text/plain",
    )

    if use_glossary and GLOSSARY_ID:
        req_kwargs["glossary_config"] = translate.TranslateTextGlossaryConfig(
            glossary=f"{PARENT}/glossaries/{GLOSSARY_ID}"
        )

    resp = _client().translate_text(**req_kwargs)

    # If a glossary is applied, Google returns the result in glossary_translations.
    if getattr(resp, "glossary_translations", None):
        return resp.glossary_translations[0].translated_text
    return resp.translations[0].translated_text

# Optional: harmless, low-cost, post-filter to avoid innuendo in a few known cases
_NEUTRAL_RULES: List[tuple[str, str]] = [
    (r"\bhaving a good time\b", "enjoying a pleasant time"),
    (r"\btonight\b", "this evening"),  # more neutral in church/family contexts
]

def post_neutralize_en(text: str) -> str:
    if not text:
        return text
    out = text
    for pat, sub in _NEUTRAL_RULES:
        out = re.sub(pat, sub, out, flags=re.IGNORECASE)
    return out
