# app/socket_manager.py

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect  # ✅ Import the missing exception
from typing import List

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except WebSocketDisconnect:
                print("❌ Skipping disconnected client.")
                disconnected.append(connection)
            except Exception as e:
                print("⚠️ WebSocket error:", str(e))
                disconnected.append(connection)

        # Clean up dead sockets
        for conn in disconnected:
            self.disconnect(conn)

# Export a singleton instance to reuse anywhere
manager = ConnectionManager()
