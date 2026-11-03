import fs from 'fs';
import path from 'path';

const pluginsDir = path.resolve('ZTools-plugins/plugins');
const dirs = fs.readdirSync(pluginsDir).filter(f => fs.statSync(path.join(pluginsDir, f)).isDirectory());

let count = 0;
let details = [];

for (const d of dirs) {
  const dirPath = path.join(pluginsDir, d);
  let manifestPath = null;
  for (const sub of ['', 'public', 'dist', 'src', 'plugin', 'app']) {
    const candidate = path.join(dirPath, sub, 'plugin.json');
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (!manifestPath) {
    details.push({ dir: d, status: 'no_manifest' });
    continue;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const mainHtml = manifest.main || 'index.html';
    // Check where mainHtml is
    let mainFound = false;
    for (const sub of ['', 'public', 'dist', 'src', 'plugin', 'app']) {
      if (fs.existsSync(path.join(dirPath, sub, mainHtml))) {
        mainFound = true;
        break;
      }
    }
    details.push({ dir: d, status: mainFound ? 'ok' : 'missing_main', manifestPath: path.relative(dirPath, manifestPath), main: mainHtml, mainFound });
  } catch (e) {
    details.push({ dir: d, status: 'error', error: e.message });
  }
}

console.log('Total plugins examined:', dirs.length);
console.log('OK plugins:', details.filter(x => x.status === 'ok').length);
console.log('Missing main:', details.filter(x => x.status === 'missing_main').map(x => x.dir));
console.log('No manifest:', details.filter(x => x.status === 'no_manifest').map(x => x.dir));
