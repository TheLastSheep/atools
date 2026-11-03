import fs from 'node:fs';
import path from 'node:path';

const PLUGINS_DIR = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .sort();

const featureTypeStats = {};
const apiCallsFound = new Set();
const cmdTypeStats = {};

for (const dir of dirs) {
  const dirPath = path.join(PLUGINS_DIR, dir);

  // Find all js / ts / vue / preload files
  function scanFiles(current) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(current, entry.name);
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.js', '.mjs', '.cjs', '.ts', '.vue', '.html', '.json'].includes(ext)) {
            // Check api calls
            if (['.js', '.mjs', '.cjs', '.ts', '.vue', '.html'].includes(ext)) {
              try {
                const code = fs.readFileSync(full, 'utf-8');
                const matches = code.matchAll(/(?:window\.)?(?:utools|ztools|atools)\.([a-zA-Z0-9_$.]+)/g);
                for (const m of matches) {
                  apiCallsFound.add(m[1]);
                }
              } catch (e) {}
            }
          }
          if (entry.name === 'plugin.json') {
            try {
              const mf = JSON.parse(fs.readFileSync(full, 'utf-8'));
              if (Array.isArray(mf.features)) {
                for (const f of mf.features) {
                  if (Array.isArray(f.cmds)) {
                    for (const cmd of f.cmds) {
                      if (typeof cmd === 'string') {
                        cmdTypeStats['string'] = (cmdTypeStats['string'] || 0) + 1;
                      } else if (typeof cmd === 'object' && cmd !== null) {
                        cmdTypeStats[cmd.type || 'unknown'] = (cmdTypeStats[cmd.type || 'unknown'] || 0) + 1;
                      }
                    }
                  }
                }
              }
            } catch (e) {}
          }
        } else if (entry.isDirectory()) {
          scanFiles(full);
        }
      }
    } catch (e) {}
  }
  scanFiles(dirPath);
}

console.log('Cmd Types found across all plugin.json:');
console.log(cmdTypeStats);

console.log('\nTop API calls found in JS code:');
const sortedApis = Array.from(apiCallsFound).sort();
console.log(sortedApis.slice(0, 100));

fs.writeFileSync('/Users/harris/Desktop/atools/scripts/plugin-api-usage.json', JSON.stringify({
  cmdTypeStats,
  apis: sortedApis
}, null, 2));
