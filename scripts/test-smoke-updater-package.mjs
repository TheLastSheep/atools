import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseUpdaterPackageSmokeOutput } from "./smoke-updater-package.mjs";

const source = await readFile(new URL("smoke-updater-package.mjs", import.meta.url), "utf8");
assert.match(source, /mkdtempSync\(join\(tmpdir\(\), "atools-updater-smoke-"\)\)/);
assert.match(source, /ATOOLS_UPDATER_SMOKE/);
assert.match(source, /2\.99\.99/);
assert.match(source, /3\.0\.0/);
assert.match(source, /invalid-signature/);
assert.match(source, /missing-architecture/);
assert.match(source, /finally\s*\{/);
assert.match(source, /rmSync\(root, \{ recursive: true, force: true \}\)/);
assert.doesNotMatch(source, /\/Applications\/ATools|\.atools\/data\.db/);

const report = {
  status: "ok",
  checks: [
    { id: "no-update", status: "ok" },
    { id: "invalid-signature", status: "ok" },
    { id: "missing-architecture", status: "ok" },
    { id: "valid-update-relaunch", status: "ok" },
  ],
};
const parsed = parseUpdaterPackageSmokeOutput(
  `noise\nATOOLS_UPDATER_PACKAGE_SMOKE ${JSON.stringify(report)}\n`,
);
assert.deepEqual(parsed, report);
assert.throws(() => parseUpdaterPackageSmokeOutput("missing"), /Missing ATOOLS_UPDATER_PACKAGE_SMOKE/);

console.log("updater package smoke contract verified");
