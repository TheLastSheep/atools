import { execSync } from 'child_process';
const out = execSync('node scripts/test-p2-storage-compatibility.mjs').toString();
console.log(out);
