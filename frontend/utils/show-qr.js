// utils/show-qr.js
const os = require('os');
const qrcode = require('qrcode-terminal');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const ip = getLocalIP();
const url = `http://${ip}:3000`;

console.log(`🌐 Access on your phone: ${url}`);
qrcode.generate(url, { small: true });
