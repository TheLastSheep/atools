import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('/Users/harris/Desktop/atools/ztools_plugin_verification_report.json', 'utf8'));

const notReady = data.filter(r => r.status !== '100%_compatible');
console.log(`Not ready plugins count: ${notReady.length}`);
for (const p of notReady) {
  console.log(`- ${p.id} (${p.title || 'no title'}): status=${p.status}, missing=${(p.missing_files || []).join(', ')}`);
}
