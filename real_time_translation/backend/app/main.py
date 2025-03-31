from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

from app.routes import translate

# ✅ Load environment variables from .env file
load_dotenv()

app = FastAPI()

# ✅ Enable CORS for all origins (change in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ⚠️ Consider restricting this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Include translation route
app.include_router(translate.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "Real-Time Sermon Translator API is live"}
