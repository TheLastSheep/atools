#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageGithubNpmPackages } from "./stage-github-npm-packages.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseWorkflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");
const packagesWorkflowPath = path.join(repoRoot, ".github", "workflows", "packages.yml");
const syncServerDockerfilePath = path.join(
  repoRoot,
  "crates",
  "atools-sync-server",
  "Dockerfile",
);

const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
const packagesWorkflow = fs.readFileSync(packagesWorkflowPath, "utf8");
const dockerfile = fs.readFileSync(syncServerDockerfilePath, "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

assert.match(releaseWorkflow, /name:\s*Release Multi-Platform & Sync Server/);
assert.match(releaseWorkflow, /tags:\s*\n\s*-\s*"v\*"/);
assert.match(releaseWorkflow, /workflow_dispatch:/);
assert.match(releaseWorkflow, /contents:\s*write/);
assert.match(releaseWorkflow, /packages:\s*write/);
assert.match(releaseWorkflow, /prepare-release:/);
assert.match(releaseWorkflow, /build-sync-server-binaries:/);
assert.match(releaseWorkflow, /build-desktop-bundles:/);
assert.match(releaseWorkflow, /publish-github-release:/);

for (const target of [
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
]) {
  assert.match(releaseWorkflow, new RegExp(target));
}

assert.match(releaseWorkflow, /pnpm tauri build --no-sign --target/);
assert.match(releaseWorkflow, /gh release create "\$RELEASE_TAG"/);
assert.match(releaseWorkflow, /SHA256SUMS\.txt/);

assert.match(packagesWorkflow, /name:\s*Publish GitHub Packages/);
assert.match(packagesWorkflow, /packages:\s*write/);
assert.match(packagesWorkflow, /publish-npm-packages:/);
assert.match(packagesWorkflow, /publish-container-package:/);
assert.match(packagesWorkflow, /registry-url:\s*"https:\/\/npm\.pkg\.github\.com"/);
assert.match(packagesWorkflow, /node scripts\/stage-github-npm-packages\.mjs/);
assert.match(packagesWorkflow, /npm publish "\$pkg_dir" --registry https:\/\/npm\.pkg\.github\.com/);
assert.match(packagesWorkflow, /ghcr\.io\/\$\{owner_lc\}\/atools-sync-server/);
assert.match(packagesWorkflow, /docker push "\$\{\{\s*steps\.meta\.outputs\.image\s*\}\}:\$\{\{\s*steps\.meta\.outputs\.version\s*\}\}"/);

assert.match(dockerfile, /cargo build --release --locked -p atools-sync-server/);
assert.match(dockerfile, /EXPOSE 23517/);
assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/TheLastSheep\/atools"/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atools-github-packages-test-"));
try {
  const summary = stageGithubNpmPackages({
    repoRoot,
    outputDir: tempRoot,
    scope: "@thelastsheep",
  });

  assert.equal(summary.version, packageJson.version);
  assert.equal(summary.registry, "https://npm.pkg.github.com");
  assert.equal(summary.packages.length, 4);

  const expectedNames = [
    "@thelastsheep/atools-ztools-renderer",
    "@thelastsheep/atools-ztools-settings",
    "@thelastsheep/atools-ztools-updater",
    "@thelastsheep/atools-host-api-shim",
  ];
  assert.deepEqual(
    summary.packages.map((item) => item.name),
    expectedNames,
  );

  for (const pkg of summary.packages) {
    const manifestPath = path.join(pkg.dir, "package.json");
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, packageJson.version);
    assert.equal(manifest.publishConfig.registry, "https://npm.pkg.github.com");
    assert.equal(manifest.repository.url, "https://github.com/TheLastSheep/atools.git");
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(
  "release & GitHub Packages workflow contract passed (.github/workflows/release.yml, .github/workflows/packages.yml, crates/atools-sync-server/Dockerfile, scripts/stage-github-npm-packages.mjs)",
);
