import fs from 'fs';
import path from 'path';

// Let's inspect test commands
const summary = JSON.parse(fs.readFileSync('audit_builtin_summary.json', 'utf8'));
console.log(`Total indexed plugins: ${summary.total}`);
const sample = summary.results.slice(0, 10);
console.log('Sample indexed plugins:', sample);
