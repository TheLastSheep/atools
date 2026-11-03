import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('/Users/harris/Desktop/atools/output_ztools_audit.json', 'utf8'));

console.log('=== Missing Manifest (6) ===');
data.results.filter(r => r.status === 'missing_manifest').forEach(r => console.log(`- ${r.id}: ${r.issues.join('; ')}`));

console.log('\n=== Has Warnings (2) ===');
data.results.filter(r => r.status === 'has_warnings').forEach(r => console.log(`- ${r.id} (${r.title}): ${r.issues.join('; ')}`));

console.log('\n=== Requires Build (19) ===');
data.results.filter(r => r.status === 'requires_build').forEach(r => {
  console.log(`- ${r.id} (${r.title}): ${r.issues.join('; ')} | has_package_json: ${r.has_package_json}, has_dist: ${r.has_dist}`);
});
