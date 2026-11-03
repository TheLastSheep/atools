import { execSync } from 'child_process';
const out = execSync('node scripts/print-summary.mjs').toString();
console.log(out);
