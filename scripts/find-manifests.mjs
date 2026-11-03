import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function collectPluginManifestPaths(root, out = []) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === "plugin.json")) {
    out.push(join(root, "plugin.json"));
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    await collectPluginManifestPaths(join(root, entry.name), out);
  }
  return out;
}

const root = resolve("./ZTools-plugins/plugins");
const manifestPaths = await collectPluginManifestPaths(root);

console.log('Total manifests found:', manifestPaths.length);

const nestedOrMultiple = [];
for (const p of manifestPaths) {
  const rel = p.replace(root + '/', '');
  const parts = rel.split('/');
  if (parts.length > 2) {
    nestedOrMultiple.push(rel);
  }
}
console.log('Nested plugin.json files (more than 1 level deep):', nestedOrMultiple.length);
console.log(nestedOrMultiple.slice(0, 30));
