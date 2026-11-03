import fs from 'node:fs';
import path from 'node:path';

const missing = ['codecalc', 'ctool', 'easy-translate', 'ibox-wallpaper', 'quickcommand', 'redis-client'];
const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';

for (const m of missing) {
  const dir = path.join(pluginRoot, m);
  if (fs.existsSync(dir)) {
    console.log(`\n--- ${m} ---`);
    console.log(fs.readdirSync(dir));
  }
}
