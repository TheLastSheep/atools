import fs from 'fs';
import path from 'path';

const sourceDir = path.resolve('ZTools-plugins/plugins');
const invalidNames = [
  'anywhere', 'bookmarks', 'chrome-history', 'clipboard-image-paintbrush',
  'deepread', 'floating', 'long-screenshot', 'nai-long-pet', 'pasteboard-pro',
  'prompt-forge', 'recent-typora', 'srktoolbox', 'text-copy', 'yanhua', 'ctool'
];

const results = [];
for (const name of invalidNames) {
  const p = path.join(sourceDir, name);
  if (!fs.existsSync(p)) {
    results.push({ name, exists: false });
    continue;
  }
  const files = fs.readdirSync(p);
  const hasPkg = fs.existsSync(path.join(p, 'package.json'));
  const hasPluginJson = fs.existsSync(path.join(p, 'plugin.json')) || fs.existsSync(path.join(p, 'public/plugin.json'));
  let pkg = null;
  if (hasPkg) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
    } catch (e) {}
  }
  results.push({
    name,
    files: files.slice(0, 10),
    hasPkg,
    scripts: pkg ? pkg.scripts : null,
    hasPluginJson
  });
}

fs.writeFileSync('scripts/p3_audit_unbuilt.json', JSON.stringify(results, null, 2));
console.log('Inspected 15 unbuilt plugins. Results written to scripts/p3_audit_unbuilt.json');
