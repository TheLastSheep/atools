import { exec } from 'node:child_process';
import util from 'node:util';

const execPromise = util.promisify(exec);

async function check() {
  try {
    const { stdout } = await execPromise('ps aux | grep -E "atools|tauri" | grep -v grep');
    console.log('Running processes:\n', stdout);
  } catch (e) {
    console.log('No matching process found.');
  }
}
check();
