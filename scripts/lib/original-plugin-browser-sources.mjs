import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";

export const originalPackages = [
  { id: "subnet-calculator", fileCount: 4, directorySha256: "99fec94248078f493627e6140c55590923255b5f08a8763c042f8cbf0463ec06" },
  { id: "uuid-kit", fileCount: 12, directorySha256: "088f727ad939b8af6063179386245cbfd96f1a227e289cba6bdf8d76ebb70e8c" },
  { id: "image-stitch", fileCount: 5, directorySha256: "2e859de1fd51297a40bc19bd6bfff757ea28d883032ca16f30dcbd9257f7e903" },
];
async function collect(root, directory, accept) {
  const paths = [];
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) paths.push(...await collect(root, path, accept));
    else if (item.isFile() && accept(path)) paths.push(path);
  }
  return paths;
}
/** Explicit selected source files, never a compiler or dependency closure claim. */
export async function captureOriginalBrowserSources(root) {
  const paths = [
    ...await collect(root, "src", path => /\.(ts|svelte|css)$/.test(path)),
    ...await collect(root, "scripts/lib", path => path.includes("/original-plugin-browser-")),
    "scripts/probe-original-plugin-business-browser.mjs", "scripts/test-original-plugin-browser.mjs",
    "scripts/test-original-plugin-browser-deadline.mjs",
    "scripts/test-original-plugin-browser-node-host.mjs",
    "tests/components/originalPluginBusinessBrowserFixture.ts", "tests/components/original-plugin-business-browser.html",
    "tests/components/originalPluginBrowserImageFixture.ts",
    "scripts/lib/launcher-menu-browser-runtime.mjs", "scripts/lib/launcher-menu-browser-report.mjs",
    "scripts/lib/launcher-menu-browser-readiness.mjs", "scripts/lib/local-plugin-fixture.mjs",
    "scripts/lib/legacy-node-webkit-fixture.mjs", "scripts/lib/legacy-node-environment.mjs", "scripts/lib/ztools-matrix-offline-policy.mjs",
    "scripts/lib/native-smoke-descendants.mjs", "crates/atools-plugin/src/legacy_node/codec.cjs", "crates/atools-plugin/src/legacy_node/bootstrap.cjs",
    "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
    "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
    "vite.config.ts", "package.json", "pnpm-lock.yaml",
  ];
  const files = await Promise.all([...new Set(paths)].sort().map(async path => {
    const bytes = await readFile(resolve(root, path));
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  return { sha256: createHash("sha256").update(files.map(item => `${item.path}\0${item.sha256}\n`).join("")).digest("hex"), files };
}
export async function captureOriginalPackages(root) {
  return Promise.all(originalPackages.map(async expected => {
    const path = `ZTools-plugins/plugins/${expected.id}`;
    const scanned = await scanLocalDirectory(resolve(root, path));
    const witness = summarizeLocalTree(scanned.files, scanned.directories);
    assert.equal(witness.fileCount, expected.fileCount, `Original ${expected.id} file count changed`);
    assert.equal(witness.directorySha256, expected.directorySha256, `Original ${expected.id} complete directory changed`);
    return { id: expected.id, path, ...witness };
  }));
}
