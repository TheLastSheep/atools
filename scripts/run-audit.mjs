// Run audit
import { execSync } from 'child_process';
import fs from 'fs';
const out = execSync('node scripts/audit-builtin-plugins.mjs').toString();
console.log(out);
