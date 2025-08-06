const os = require('os');
const fs = require('fs');
const path = require('path');

function getPreferredIP() {
  const interfaces = os.networkInterfaces();
  let candidate = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('10.')) {
          return iface.address; // Prefer 10.x.x.x (Wi-Fi LAN IP)
        }
        if (iface.address.startsWith('172.')) {
          candidate = iface.address; // Fallback to 172.x.x.x (WSL)
        }
      }
    }
  }
  return candidate || '127.0.0.1';
}

const ip = getPreferredIP();
const envPath = path.join(__dirname, '../.env.local');
const content = `NEXT_PUBLIC_API_BASE_URL=http://${ip}:8000\nNEXT_PUBLIC_WS_URL=ws://${ip}:8000\n`;

fs.writeFileSync(envPath, content);
console.log(`✅ .env.local updated with dynamic IP:\n${content}`);
