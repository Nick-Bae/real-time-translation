const http = require('http');
const WebSocket = require('ws');

const BASE_HOST = 'localhost';
const BACKEND_PORT = 8000;
const FRONTEND_PORT = 3000;

const urls = {
  backend: `http://${BASE_HOST}:${BACKEND_PORT}/`,
  frontend: `http://${BASE_HOST}:${FRONTEND_PORT}/`,
  websocket: `ws://${BASE_HOST}:${BACKEND_PORT}/ws/translate`,
};

function checkHttp(name, url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve({ name, status: res.statusCode, ok: res.statusCode === 200 });
    });
    req.on('error', () => resolve({ name, status: 'ERROR', ok: false }));
  });
}

function checkWebSocket(name, url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      resolve({ name, status: 'CONNECTED', ok: true });
      ws.close();
    });
    ws.on('error', () => resolve({ name, status: 'ERROR', ok: false }));
  });
}

async function runChecks() {
  const results = await Promise.all([
    checkHttp('Backend', urls.backend),
    checkHttp('Frontend', urls.frontend),
    checkWebSocket('WebSocket', urls.websocket),
  ]);

  console.log('\n🧪 Status Check Summary:\n');
  results.forEach(({ name, status, ok }) => {
    const symbol = ok ? '✅' : '❌';
    console.log(`${symbol} ${name}: ${status}`);
  });

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

runChecks();
