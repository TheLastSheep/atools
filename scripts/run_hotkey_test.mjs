import { execSync } from 'child_process';
const out = execSync('node scripts/test_hotkey_direct_launch.mjs').toString();
console.log(out);
