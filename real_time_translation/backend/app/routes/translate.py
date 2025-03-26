from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.gpt_service import translate_text

router = APIRouter()

class TranslationRequest(BaseModel):
    text: str
    source: str = "Korean"
    target: str = "Chinese"

@router.post("/translate")
async def translate(request: TranslationRequest):
    try:
        result = translate_text(request.text, request.source, request.target)
        return {"translated": result}
    except Exception as e:
        print(f"Translation failed: {e}")  # ← Add this line for logging
        raise HTTPException(status_code=500, detail=str(e))
