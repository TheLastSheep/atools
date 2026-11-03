import fs from 'node:fs';
import path from 'node:path';

const PLUGINS_DIR = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';

// We want to verify each of the 167 plugin directories.
const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .sort();

console.log(`Auditing ${dirs.length} plugin directories in ${PLUGINS_DIR}...\n`);

const results = [];

for (const dir of dirs) {
  const dirPath = path.join(PLUGINS_DIR, dir);
  
  // Find all plugin.json
  const manifestFiles = [];
  function search(current, depth = 0) {
    if (depth > 5) return;
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(current, entry.name);
        if (entry.isFile() && entry.name === 'plugin.json') {
          manifestFiles.push(full);
        } else if (entry.isDirectory()) {
          search(full, depth + 1);
        }
      }
    } catch (e) {}
  }
  search(dirPath);

  // Check each manifest
  const manifestAudits = [];
  for (const mf of manifestFiles) {
    const relMf = path.relative(dirPath, mf);
    const manifestDir = path.dirname(mf);
    try {
      const content = JSON.parse(fs.readFileSync(mf, 'utf-8'));
      const main = content.main;
      const preload = content.preload;
      const logo = content.logo;
      
      const mainPath = main ? path.resolve(manifestDir, main) : null;
      const preloadPath = preload ? path.resolve(manifestDir, preload) : null;
      const logoPath = logo ? path.resolve(manifestDir, logo) : null;

      const mainExists = main ? (main.startsWith('http://') || main.startsWith('https://') || fs.existsSync(mainPath)) : false;
      const preloadExists = preload ? fs.existsSync(preloadPath) : true;
      const logoExists = logo ? fs.existsSync(logoPath) : true;

      manifestAudits.push({
        path: relMf,
        name: content.name,
        title: content.title || content.pluginName,
        version: content.version,
        main,
        mainExists,
        preload,
        preloadExists,
        logo,
        logoExists,
        features: content.features ? content.features.length : 0,
        cmds: content.features ? content.features.flatMap(f => f.cmds || []).length : 0,
        platform: content.platform || null,
        development: content.development || null,
        pluginSetting: content.pluginSetting || null
      });
    } catch (err) {
      manifestAudits.push({
        path: relMf,
        error: err.message
      });
    }
  }

  // Determine plugin state
  // 1. Has root plugin.json with built assets?
  const rootMf = manifestAudits.find(m => m.path === 'plugin.json');
  const distMf = manifestAudits.find(m => m.path === 'dist/plugin.json');
  const publicMf = manifestAudits.find(m => m.path === 'public/plugin.json');

  let status = 'unknown';
  let bestManifest = null;

  if (rootMf && rootMf.mainExists) {
    status = 'ready_built_root';
    bestManifest = rootMf;
  } else if (distMf && distMf.mainExists) {
    status = 'ready_built_dist';
    bestManifest = distMf;
  } else if (rootMf && !rootMf.mainExists) {
    status = 'source_only_root_manifest';
    bestManifest = rootMf;
  } else if (publicMf) {
    status = 'source_only_vite_public';
    bestManifest = publicMf;
  } else if (manifestAudits.length > 0) {
    status = 'other_structure';
    bestManifest = manifestAudits[0];
  } else {
    status = 'no_manifest';
  }

  results.push({
    dir,
    manifestCount: manifestFiles.length,
    manifests: manifestAudits,
    status,
    bestManifest
  });
}

const statusCounts = {};
for (const r of results) {
  statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
}

console.log('Status counts across 167 plugin folders:');
console.log(statusCounts);

// Let's print out the list of ready_built plugins
const readyBuilt = results.filter(r => r.status.startsWith('ready_built'));
console.log(`\nReady built plugins (${readyBuilt.length}):`);
for (const r of readyBuilt) {
  console.log(`- ${r.dir} (${r.status}): ${r.bestManifest.title || r.bestManifest.name} (main: ${r.bestManifest.main})`);
}

// Let's print source only plugins
const sourceOnly = results.filter(r => r.status.startsWith('source_only'));
console.log(`\nSource only (unbuilt) plugins (${sourceOnly.length}):`);
for (const r of sourceOnly) {
  console.log(`- ${r.dir} (${r.status}): ${r.bestManifest.title || r.bestManifest.name} (main: ${r.bestManifest.main})`);
}

fs.writeFileSync('/Users/harris/Desktop/atools/scripts/plugin-audit-summary.json', JSON.stringify(results, null, 2));
