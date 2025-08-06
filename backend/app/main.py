import os, json
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from app.routes import translate
from typing import List
from app.socket_manager import manager

app = FastAPI()

load_dotenv()

origins = os.getenv("ALLOWED_ORIGINS", "").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(translate.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "Server is live"}

# This endpoint is not necessary if you're using broadcast flow
# You can comment/remove this:
# @app.websocket("/ws")
# async def websocket_endpoint(websocket: WebSocket):
#     await websocket.accept()
#     while True:
#         data = await websocket.receive_text()
#         await websocket.send_text(json.dumps(f"Received: {data}"))

@app.websocket("/ws/translate")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await asyncio.sleep(1)  # Passive loop to keep connection alive
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
        print("❌ Listener disconnected")

@app.post("/api/broadcast")
async def broadcast_translation(request: Request):
    data = await request.json()
    text = data.get("text", "")
    lang = data.get("lang", "en")

    payload = {
        "type": "translation",
        "payload": text,
        "lang": lang,
    }

    print("📡 Broadcasting translation:", payload)
    await manager.broadcast(payload)
    return {"message": "Broadcasted"}
