import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const missing = [
  'anywhere',
  'bookmarks',
  'chrome-history',
  'clipboard-image-paintbrush',
  'deepread',
  'floating',
  'long-screenshot',
  'nai-long-pet',
  'pasteboard-pro',
  'prompt-forge',
  'quickcommand',
  'recent-typora',
  'srktoolbox',
  'text-copy',
  'yanhua'
];

for (const name of missing) {
  const dir = path.resolve('ZTools-plugins/plugins', name);
  const pkgPath = path.join(dir, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  let buildScript = null;
  if (hasPkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      buildScript = pkg.scripts?.build;
    } catch {}
  }
  console.log(`${name}: hasPkg=${hasPkg}, build=${buildScript}`);
}
