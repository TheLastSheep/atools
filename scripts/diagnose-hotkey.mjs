import { exec } from 'node:child_process';
import util from 'node:util';

const execPromise = util.promisify(exec);

async function diagnose() {
  console.log('=== 1. Checking running atools/tauri processes ===');
  try {
    const { stdout } = await execPromise('ps aux | grep -i -E "atools|tauri" | grep -v grep');
    console.log(stdout || 'No atools process running!');
  } catch (e) {
    console.log('No atools process running.');
  }

  console.log('\n=== 2. Checking macOS Accessibility permissions ===');
  try {
    const { stdout } = await execPromise('tccutil status Accessibility 2>&1 || echo "Cannot query tccutil directly"');
    console.log(stdout);
  } catch (e) {
    console.log(e.message);
  }

  console.log('\n=== 3. Checking built desktop binaries ===');
  try {
    const { stdout } = await execPromise('ls -la src-tauri/target/release/atools src-tauri/target/debug/atools 2>/dev/null || echo "No binary in target"');
    console.log(stdout);
  } catch (e) {
    console.log(e.message);
  }
}

diagnose();
