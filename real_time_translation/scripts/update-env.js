// scripts/update-env.js
const os = require('os');
const fs = require('fs');
const path = require('path');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const ip = getLocalIP();
const envPath = path.join(__dirname, '../frontend/.env.local');
const content = `NEXT_PUBLIC_API_BASE_URL=http://${ip}:8000\nNEXT_PUBLIC_WS_URL=ws://${ip}:8000\n`;

fs.writeFileSync(envPath, content);
console.log(`✅ .env.local updated with dynamic IP:\n${content}`);
