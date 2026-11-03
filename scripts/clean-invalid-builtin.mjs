import fs from 'fs';
import path from 'path';

const targetBuiltinDir = path.resolve('resources/plugins/builtin');
const plugins = fs.readdirSync(targetBuiltinDir).filter(f => fs.statSync(path.join(targetBuiltinDir, f)).isDirectory());

const invalidNames = [
  'anywhere', 'bookmarks', 'chrome-history', 'clipboard-image-paintbrush',
  'deepread', 'floating', 'long-screenshot', 'nai-long-pet', 'pasteboard-pro',
  'prompt-forge', 'recent-typora', 'srktoolbox', 'text-copy', 'yanhua', 'ctool'
];

for (const name of invalidNames) {
  const dir = path.join(targetBuiltinDir, name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Cleaned up invalid plugin: ${name}`);
  }
}
