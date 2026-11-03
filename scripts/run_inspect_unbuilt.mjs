import { execSync } from 'child_process';
const out = execSync('node scripts/inspect_unbuilt.mjs').toString();
console.log(out);
