import fs from 'fs';
const summary = JSON.parse(fs.readFileSync('audit_builtin_summary.json', 'utf8'));
console.log('Total:', summary.total);
console.log('Sample:', summary.results.slice(0, 5));
