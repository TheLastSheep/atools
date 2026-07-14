import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { classifyTestScripts } from "./test-tiers.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const browserUtils = await readFile(new URL("scripts/chrome-cdp-smoke-utils.mjs", root), "utf8");
const tiers = classifyTestScripts(packageJson.scripts);
const focusedScripts = Object.keys(packageJson.scripts).filter((name) => /^test:[^:]+/.test(name));

assert.ok(tiers.fast.includes("test:settings-normalization"));
assert.ok(tiers.fast.includes("test:plugin-invoke-policy"));
assert.ok(tiers.fast.includes("test:plugin-window-browser-bridge"));
assert.ok(tiers.fast.includes("test:hosted-browser-window-isolation"));
assert.ok(tiers.browser.includes("test:plugin-host-smoke-browser"));
assert.ok(tiers.browser.includes("test:plugin-iframe-context-menu"));
assert.ok(tiers.browser.includes("test:ztools-ui-host-plugin-panel-matrix-browser"));
assert.ok(!tiers.fast.includes("test:plugin-iframe-context-menu"));

const aggregateNames = new Set([
  "test:fast",
  "test:rust",
  "test:browser",
  "test:desktop",
  "test:release",
  "test:all",
]);
assert.ok(tiers.fast.every((name) => !aggregateNames.has(name)));
assert.ok(tiers.browser.every((name) => !aggregateNames.has(name)));

const classified = [...tiers.fast, ...tiers.browser].sort();
const expected = focusedScripts.filter((name) => !aggregateNames.has(name)).sort();
assert.deepEqual(classified, expected, "every focused Node test must belong to exactly one tier");
assert.equal(new Set(classified).size, classified.length, "test tiers must not overlap");

assert.equal(packageJson.scripts.test, "pnpm test:fast");
assert.equal(packageJson.scripts["test:fast"], "node scripts/run-test-tier.mjs fast");
assert.equal(packageJson.scripts["test:rust"], "cargo test --workspace");
assert.equal(packageJson.scripts["test:browser"], "node scripts/run-test-tier.mjs browser");
assert.equal(packageJson.scripts["test:desktop"], "pnpm smoke:tauri-desktop");
assert.equal(packageJson.scripts["test:release"], "pnpm release:check:macos");
assert.match(
  browserUtils,
  /spawn\(process\.execPath, \[viteEntry/,
  "browser tests must launch Vite directly so teardown owns the listening process",
);
assert.doesNotMatch(
  browserUtils,
  /spawn\("pnpm", \["exec", "vite"/,
  "browser tests must not leave a Vite grandchild behind after killing pnpm",
);
assert.doesNotMatch(
  browserUtils,
  /readyPattern\.test/,
  "browser tests must use the HTTP probe instead of depending on ANSI-formatted Vite output",
);

const screenshotCapture = await readFile(new URL("scripts/capture-ztools-ui-host-screenshots.mjs", root), "utf8");
assert.match(screenshotCapture, /body \? body\.scrollWidth > body\.clientWidth \+ 1 : false/);
