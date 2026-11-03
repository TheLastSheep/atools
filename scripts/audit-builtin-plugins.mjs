import fs from 'fs';
import path from 'path';

const builtinDir = path.resolve('resources/plugins/builtin');
const pluginDirs = fs.readdirSync(builtinDir).map(d => path.join(builtinDir, d)).filter(p => fs.statSync(p).isDirectory());

console.log(`Auditing ${pluginDirs.length} builtin plugins...`);

let successCount = 0;
let failCount = 0;
const results = [];

for (const p of pluginDirs) {
  const pluginName = path.basename(p);
  let manifestPath = path.join(p, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(path.join(p, 'public/plugin.json'))) {
      manifestPath = path.join(p, 'public/plugin.json');
    }
  }

  if (!fs.existsSync(manifestPath)) {
    failCount++;
    results.push({ name: pluginName, status: 'missing_manifest' });
    continue;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mainFile = manifest.main || 'index.html';
    const mainPath = path.join(p, mainFile);
    if (!fs.existsSync(mainPath)) {
      failCount++;
      results.push({ name: pluginName, status: 'missing_main', main: mainFile });
      continue;
    }

    const cmds = [];
    if (Array.isArray(manifest.features)) {
      for (const feat of manifest.features) {
        if (Array.isArray(feat.cmds)) {
          for (const cmd of feat.cmds) {
            if (typeof cmd === 'string') cmds.push(cmd);
            else if (cmd && cmd.label) cmds.push(cmd.label);
          }
        }
      }
    }

    successCount++;
    results.push({
      name: pluginName,
      pluginNameZh: manifest.pluginName,
      status: 'ok',
      version: manifest.version,
      commandsCount: cmds.length
    });
  } catch (err) {
    failCount++;
    results.push({ name: pluginName, status: 'error', error: err.message });
  }
}

console.log(`\nAudit Complete:`);
console.log(`Total Plugins: ${pluginDirs.length}`);
console.log(`Valid & Ready: ${successCount}`);
console.log(`Failed: ${failCount}`);

fs.writeFileSync('audit_builtin_summary.json', JSON.stringify({ total: pluginDirs.length, successCount, failCount, results }, null, 2));
