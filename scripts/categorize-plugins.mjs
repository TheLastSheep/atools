import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve("./ZTools-plugins/plugins");
const pluginDirs = await readdir(root, { withFileTypes: true });

let totalDirs = 0;
const categorized = {
  rootPluginJson: [],
  nestedPluginJson: [],
  noPluginJson: []
};

for (const dir of pluginDirs) {
  if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
  totalDirs++;
  const dirPath = join(root, dir.name);
  
  // check if dirPath has plugin.json
  const subEntries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const hasRoot = subEntries.some(e => e.isFile() && e.name === "plugin.json");
  if (hasRoot) {
    categorized.rootPluginJson.push(dir.name);
  } else {
    // find nested plugin.json
    const nested = [];
    async function findNested(p, depth=0) {
      if (depth > 4) return;
      const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
          await findNested(join(p, e.name), depth + 1);
        } else if (e.isFile() && e.name === 'plugin.json') {
          nested.push(join(p, e.name).replace(dirPath + '/', ''));
        }
      }
    }
    await findNested(dirPath);
    if (nested.length > 0) {
      categorized.nestedPluginJson.push({ dir: dir.name, nested });
    } else {
      categorized.noPluginJson.push(dir.name);
    }
  }
}

console.log('Total plugin directories:', totalDirs);
console.log('Direct root plugin.json count:', categorized.rootPluginJson.length);
console.log('Nested plugin.json count:', categorized.nestedPluginJson.length);
console.log('No plugin.json count:', categorized.noPluginJson.length);
console.log('\nNested samples:');
console.log(categorized.nestedPluginJson.slice(0, 20));
