from fastapi import APIRouter, HTTPException
from app.utils.translate import translate_text
from app.socket_manager import manager  # ✅ Import the connection manager

router = APIRouter()

@router.post("/translate")
async def translate(data: dict):
    text = data.get("text", "")
    source = data.get("source", "ko")
    target = data.get("target", "en")

    if not text:
        raise HTTPException(status_code=400, detail="No text provided for translation")

    translation = translate_text(text, source, target)

    if "Translation failed" in translation:
        raise HTTPException(status_code=500, detail=translation)

    # ✅ WebSocket broadcast here!
    await manager.broadcast({
        "type": "translation",
        "payload": translation,
        "lang": target
    })

    return {"translated": translation}
