import fs from 'fs';
import path from 'path';

// Let's audit all 161 plugins for commands & cmds features
const summary = JSON.parse(fs.readFileSync('audit_builtin_summary.json', 'utf8'));

let featureCount = 0;
let cmdTypes = {
  text: 0,
  regex: 0,
  over: 0,
  img: 0,
  files: 0,
  window: 0,
  unknown: 0
};

for (const p of summary.results) {
  if (p.manifest && Array.isArray(p.manifest.features)) {
    for (const f of p.manifest.features) {
      featureCount++;
      if (Array.isArray(f.cmds)) {
        for (const cmd of f.cmds) {
          if (typeof cmd === 'string') {
            cmdTypes.text++;
          } else if (cmd && typeof cmd === 'object') {
            const t = cmd.type || 'text';
            if (cmdTypes[t] !== undefined) {
              cmdTypes[t]++;
            } else {
              cmdTypes.unknown++;
            }
          }
        }
      }
    }
  }
}

const auditP3Report = {
  totalPlugins: summary.total,
  totalFeatures: featureCount,
  cmdDistribution: cmdTypes,
  allReady: summary.validCount === summary.total
};

fs.writeFileSync('scripts/p3_features_summary.json', JSON.stringify(auditP3Report, null, 2), 'utf8');
console.log('P3 Audit Features Summary:', auditP3Report);
