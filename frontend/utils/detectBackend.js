const os = require('os');
const fs = require('fs');
const path = require('path');

// Function to get preferred network IP (Wi-Fi or Ethernet)
function getPreferredNetworkIP() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    if (/vEthernet|WSL|Hyper-V|Loopback/i.test(name)) {
      continue; // Skip virtual adapters
    }

    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('10.') || iface.address.startsWith('192.168.') || iface.address.startsWith('172.')) {
          return iface.address;
        }
      }
    }
  }

  throw new Error('No valid network IP found');
}

// Main Execution
try {
  const ip = getPreferredNetworkIP();
  const envPath = path.join(__dirname, '../.env.local');
  const envContent = `NEXT_PUBLIC_API_BASE_URL=http://${ip}:8000\nNEXT_PUBLIC_WS_URL=ws://${ip}:8000\n`;

  fs.writeFileSync(envPath, envContent);
  console.log(`✅ .env.local updated with dynamic IP:\n${envContent}`);
} catch (err) {
  console.error('❌ Failed to detect IP:', err.message);
  process.exit(1);
}
