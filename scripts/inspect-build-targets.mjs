import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const targets = [
  'ai-skills-manager', 'anywhere', 'deepread', 'pasteboard-pro', 'prompt-forge', 'srktoolbox', 'zapapi'
];

for (const t of targets) {
  const dir = path.join(pluginRoot, t);
  console.log(`\n=== ${t} ===`);
  if (fs.existsSync(dir)) {
    console.log(fs.readdirSync(dir));
    const publicDir = path.join(dir, 'public');
    if (fs.existsSync(publicDir)) {
      console.log(' public/:', fs.readdirSync(publicDir));
    }
  }
}
