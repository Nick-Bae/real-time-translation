const { exec } = require('child_process');
const os = require('os');

const isWindows = os.platform() === 'win32';

if (isWindows) {
  console.log('🖥️ Detected Windows. Running start-backend.bat...');
  exec('cd ../backend && start-backend.bat', (err, stdout, stderr) => {
    if (err) {
      console.error(`❌ Error running backend: ${err}`);
      return;
    }
    console.log(stdout);
    console.error(stderr);
  });
} else {
  console.log('🍎 Detected Mac/Linux. Running start-backend.command...');
  exec('cd ../backend && bash start-backend.command', (err, stdout, stderr) => {
    if (err) {
      console.error(`❌ Error running backend: ${err}`);
      return;
    }
    console.log(stdout);
    console.error(stderr);
  });
}
