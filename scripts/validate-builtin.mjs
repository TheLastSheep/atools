import fs from 'fs';
import path from 'path';

const targetBuiltinDir = path.resolve('resources/plugins/builtin');
const plugins = fs.readdirSync(targetBuiltinDir).filter(f => fs.statSync(path.join(targetBuiltinDir, f)).isDirectory());

let valid = 0;
let invalid = [];

for (const p of plugins) {
  const pDir = path.join(targetBuiltinDir, p);
  const manifestPath = path.join(pDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    invalid.push({ name: p, reason: 'no plugin.json' });
    continue;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.pluginName && !manifest.name) {
      invalid.push({ name: p, reason: 'missing pluginName/name' });
      continue;
    }
    if (!manifest.main) {
      invalid.push({ name: p, reason: 'missing main' });
      continue;
    }
    const mainPath = path.join(pDir, manifest.main);
    if (!fs.existsSync(mainPath)) {
      invalid.push({ name: p, reason: `main file not found at ${manifest.main}` });
      continue;
    }
    valid++;
  } catch (e) {
    invalid.push({ name: p, reason: e.message });
  }
}

console.log(`Validated ${valid} out of ${plugins.length} plugins in builtin.`);
if (invalid.length > 0) {
  console.log('Invalid plugins:', invalid);
}
