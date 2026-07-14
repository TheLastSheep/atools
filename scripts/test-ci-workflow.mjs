import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");

assert.equal(packageJson.packageManager, "pnpm@11.7.0");
assert.equal(
  packageJson.scripts["release:check:macos:unsigned"],
  "node scripts/check-macos-release-readiness.mjs --expect-signing-free",
);

assert.match(workflow, /^name:\s*CI$/m);
assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /push:/);
assert.match(workflow, /runs-on:\s*macos-latest/g);
assert.equal(workflow.match(/dtolnay\/rust-toolchain@1\.97\.0/g)?.length, 2);
assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain@stable/);
assert.match(workflow, /pnpm install --frozen-lockfile/);
assert.match(workflow, /cargo fmt --all -- --check/);
assert.match(workflow, /cargo clippy --workspace --all-targets -- -D warnings/);
assert.match(workflow, /::error title=Clippy diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Fast-tier diagnostics::\$diagnostic/);
assert.match(workflow, /cargo test --workspace/);
assert.match(workflow, /pnpm test:fast/);
assert.match(workflow, /pnpm check/);
assert.match(workflow, /pnpm build/);
assert.match(workflow, /pnpm test:browser/);
assert.match(workflow, /pnpm test:desktop/);
assert.match(workflow, /pnpm release:check:macos:unsigned/);
assert.ok(
  workflow.indexOf("- run: pnpm build") < workflow.indexOf("cargo clippy --workspace --all-targets -- -D warnings"),
  "quality CI should create frontendDist before Tauri macros run under Clippy",
);
assert.doesNotMatch(
  workflow,
  /node_modules|ATOOLS_PLUGIN_MARKET_TRUSTED_PUBLIC_KEYS|TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_PASSWORD|KEYCHAIN_PASSWORD/,
);
