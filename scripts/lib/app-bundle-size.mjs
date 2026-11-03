import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Count the app-bundle tree using the same lstat/symlink semantics as the runtime benchmark. */
export function appBundleBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + appBundleBytes(join(path, entry)), 0);
}
