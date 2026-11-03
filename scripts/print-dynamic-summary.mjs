import fs from 'node:fs';

const results = JSON.parse(fs.readFileSync('/Users/harris/Desktop/atools/dynamic_execution_test_report.json', 'utf8'));

console.log('=== Sample Dynamic Test Results (10) ===');
results.slice(0, 15).forEach(r => {
  console.log(`- [${r.status}] ${r.id} (${r.title || 'no title'}): preload=${r.preloadLoaded}, scriptsExecuted=${r.scriptsExecuted}, apiCalls=${r.apiCalls ? r.apiCalls.length : 0}`);
});

console.log('\n=== Summary of 167 Plugins ===');
const passed = results.filter(r => r.status === 'PASS' || r.status === 'COMPATIBLE_WITH_LOGS');
const reqBuild = results.filter(r => r.status === 'REQUIRES_BUILD');
const missing = results.filter(r => r.status === 'MISSING_MANIFEST');

console.log(`Passed (Executed): ${passed.length}`);
console.log(`Requires Build: ${reqBuild.length}`);
console.log(`Missing Manifest: ${missing.length}`);
