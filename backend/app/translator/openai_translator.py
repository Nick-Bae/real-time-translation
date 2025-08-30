from __future__ import annotations
import httpx
from ..env import ENV

async def translate_ko_to_en_chunk(ko: str) -> str:
    if not ENV.OPENAI_API_KEY: return ko  # fall back to echo to keep pipeline flowing
    sys = (
        "You translate short Korean fragments to natural, concise English for live "
        "worship captions. Use SVO order. Preserve names/titles. Do not rewrite "
        "previous lines. Output only the translation."
    )
    body = {"model": ENV.TRANSLATION_MODEL, "temperature": 0.2,
            "messages": [{"role":"system","content":sys}, {"role":"user","content":ko}]}
    headers = {"Authorization": f"Bearer {ENV.OPENAI_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post("https://api.openai.com/v1/chat/completions", json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
        return (data.get("choices", [{}])[0].get("message", {}).get("content", "").strip() or ko)