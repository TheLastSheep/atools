import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve("./ZTools-plugins/plugins");
const pluginDirs = await readdir(root, { withFileTypes: true });

async function fileExists(p) {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function findPluginJsons(dir) {
  const list = [];
  async function walk(current, depth = 0) {
    if (depth > 5) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const fullPath = join(current, e.name);
      if (e.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (e.isFile() && e.name === 'plugin.json') {
        list.push(fullPath);
      }
    }
  }
  await walk(dir);
  return list;
}

const audit = [];

for (const dir of pluginDirs) {
  if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
  const dirPath = join(root, dir.name);
  const manifests = await findPluginJsons(dirPath);
  
  audit.push({
    dirName: dir.name,
    manifestCount: manifests.length,
    manifests: manifests.map(m => m.replace(dirPath + '/', ''))
  });
}

console.log('Total dirs:', audit.length);
console.log('Dirs with 0 manifests:', audit.filter(a => a.manifestCount === 0).map(a => a.dirName));
console.log('Dirs with 1 manifest:', audit.filter(a => a.manifestCount === 1).length);
console.log('Dirs with >1 manifests:', audit.filter(a => a.manifestCount > 1).length);
console.log('Sample of >1 manifests:', audit.filter(a => a.manifestCount > 1));
