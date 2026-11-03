import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync('/Users/harris/Desktop/atools/ztools_plugin_full_detailed_audit.json', 'utf8'));

const reqBuild = report.filter(r => r.compatibility_status === 'REQUIRES_BUILD_OR_DEV_SETUP');
console.log('=== REQUIRES BUILD OR DEV SETUP ===');
for (const p of reqBuild) {
  console.log(`- ${p.id} (${p.title}): main=${p.main}, preload=${p.preload}, notes=${p.notes.join('; ')}`);
}
