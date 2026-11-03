import { execSync } from 'child_process';
const out = execSync('node scripts/audit-p3-features.mjs').toString();
console.log(out);
