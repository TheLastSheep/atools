import fs from 'node:fs';
import path from 'node:path';

const baseDir = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const entries = fs.readdirSync(baseDir, { withFileTypes: true });

const results = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(baseDir, entry.name);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    results.push({ name: entry.name, error: 'No plugin.json' });
    continue;
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const json = JSON.parse(raw);
    const files = fs.readdirSync(dir);
    
    // Check main, preload, logo
    const main = json.main;
    const preload = json.preload;
    const logo = json.logo;
    
    const mainExists = main ? fs.existsSync(path.join(dir, main)) : null;
    const preloadExists = preload ? fs.existsSync(path.join(dir, preload)) : null;
    const logoExists = logo ? fs.existsSync(path.join(dir, logo)) : null;
    
    results.push({
      dirName: entry.name,
      pluginName: json.name,
      pluginTitle: json.pluginName || json.title,
      main,
      mainExists,
      preload,
      preloadExists,
      logo,
      logoExists,
      files,
      features: (json.features || []).map(f => ({
        code: f.code,
        cmds: (f.cmds || []).map(c => typeof c === 'string' ? c : c.type)
      }))
    });
  } catch (e) {
    results.push({ dirName: entry.name, error: e.message });
  }
}

console.log('Total plugins inspected:', results.length);
const missingMain = results.filter(r => r.main && r.mainExists === false);
const missingPreload = results.filter(r => r.preload && r.preloadExists === false);
const missingLogo = results.filter(r => r.logo && r.logoExists === false);
const noMainSpecified = results.filter(r => !r.main && !r.error);

console.log('Missing main (file specified but not found):', missingMain.length);
console.log('No main specified (preload-only / headless / list?):', noMainSpecified.length);
console.log('Missing preload:', missingPreload.length);
console.log('Missing logo:', missingLogo.length);

console.log('\n--- Sample of missingMain (first 10) ---');
for (const item of missingMain.slice(0, 10)) {
  console.log(item.dirName, '-> main:', item.main, 'files in dir:', item.files);
}

console.log('\n--- Sample of noMainSpecified (first 10) ---');
for (const item of noMainSpecified.slice(0, 10)) {
  console.log(item.dirName, '-> preload:', item.preload, 'files in dir:', item.files);
}
