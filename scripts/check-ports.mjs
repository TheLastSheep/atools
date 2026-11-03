import { exec } from 'node:child_process';
import util from 'node:util';

const execPromise = util.promisify(exec);

async function run() {
  try {
    const { stdout } = await execPromise('lsof -i :1420 -i :3000 -i :5173');
    console.log('Active ports:\n', stdout);
  } catch (e) {
    console.log('No web dev server listening on common ports.');
  }
}
run();
