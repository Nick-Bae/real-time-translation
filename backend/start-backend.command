#!/bin/bash
# backend/start-backend.command

echo "🍎 Running backend for Mac/Linux..."

# Go to backend directory
cd "$(dirname "$0")/.."
cd backend

# Get local IP (first private IP found)
IP=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -n 1)

echo "🌐 Your Local IP is: http://$IP:3000"
echo "✅ Backend API will run on: http://$IP:8000"

# Check if venv exists
if [ ! -f venv/bin/activate ]; then
  echo "❌ Virtual environment not found."
  echo "💡 Run: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

# Activate venv
source venv/bin/activate

echo "🐍 Python used: $(which python)"
echo "📦 Running Uvicorn..."

# Run FastAPI
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
