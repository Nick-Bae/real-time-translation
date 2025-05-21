import socket
from pathlib import Path

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

ip = get_local_ip()
env_text = f"""NEXT_PUBLIC_API_BASE_URL=http://{ip}:8000
NEXT_PUBLIC_WS_URL=ws://{ip}:8000
"""

frontend_env_path = Path("frontend") / ".env.local"
frontend_env_path.parent.mkdir(parents=True, exist_ok=True)
frontend_env_path.write_text(env_text)

print("✅ .env.local updated with:")
print(env_text)
