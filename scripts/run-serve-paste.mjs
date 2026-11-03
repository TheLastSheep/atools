import { exec } from 'node:child_process';
import util from 'node:util';

const execPromise = util.promisify(exec);

async function test() {
  const { stdout } = await execPromise('node scripts/serve-paste-shelf.mjs &');
  console.log('Started:', stdout);
}
test();
