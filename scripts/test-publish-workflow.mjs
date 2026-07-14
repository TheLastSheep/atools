import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateReleaseTag } from "./validate-release-tag.mjs";
import { normalizeStableReleaseTag } from "./version-contract.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/publish-macos.yml", root), "utf8");
assert.equal(workflow.match(/dtolnay\/rust-toolchain@1\.97\.0/g)?.length, 2);
assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain@stable/);
const ciWorkflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
assert.ok(
  workflow.indexOf("- run: pnpm build") < workflow.indexOf("- run: cargo clippy --workspace --all-targets -- -D warnings"),
  "release validation should create frontendDist before Tauri macros run under Clippy",
);

assert.equal(
  packageJson.scripts["test:publish-workflow"],
  "node scripts/test-publish-workflow.mjs",
);
assert.match(workflow, /^name:\s*Publish macOS$/m);
assert.match(workflow, /tags:\s*\n\s+- ["']v\*["']/);
assert.match(workflow, /permissions:\s*\n\s+contents:\s*write/);
assert.match(workflow, /validate-version:/);
assert.match(workflow, /prepare-draft:/);
assert.match(workflow, /publish-macos:/);
assert.match(workflow, /max-parallel:\s*1/);
assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
assert.match(workflow, /runner:\s*macos-15\b/);
assert.match(workflow, /runner:\s*macos-15-intel\b/);
assert.match(workflow, /aarch64-apple-darwin/);
assert.match(workflow, /x86_64-apple-darwin/);
assert.match(workflow, /releaseId:/);
assert.match(workflow, /verify-release:/);
assert.match(workflow, /verify-bundle:/);
assert.match(workflow, /promote-release:/);
assert.match(workflow, /tauri-apps\/tauri-action@v0/);
assert.match(workflow, /uploadUpdaterJson:\s*true/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /APPLE_CERTIFICATE/);
assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --draft=false --prerelease=false --latest/);
assert.doesNotMatch(workflow, /pull_request:/);

assert.match(ciWorkflow, /permissions:\s*\n\s+contents:\s*read/);
assert.doesNotMatch(
  ciWorkflow,
  /TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_PASSWORD|KEYCHAIN_PASSWORD/,
  "ordinary CI must never receive release signing secrets",
);

assert.equal(normalizeStableReleaseTag("v3.0.0"), "3.0.0");
assert.throws(() => normalizeStableReleaseTag("3.0.0"), /stable vX\.Y\.Z/);
assert.throws(() => normalizeStableReleaseTag("v3.0.0-rc.1"), /stable vX\.Y\.Z/);
assert.deepEqual(await validateReleaseTag("v3.0.0", root), { version: "3.0.0" });
await assert.rejects(() => validateReleaseTag("v3.0.1", root), /requested release version/);

console.log("publish workflow contract verified");
