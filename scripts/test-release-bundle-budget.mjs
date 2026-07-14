import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const INITIAL_JS_BUDGET_BYTES = 560 * 1024;
const KNOWN_LAZY_CHUNK_PREFIXES = ["plugin-panel-", "pinyin-engine-"];

const distDir = await mkdtemp(join(tmpdir(), "atools-release-budget-"));
const viteEntry = join(root, "node_modules", "vite", "bin", "vite.js");
const buildEnv = { ...process.env };
delete buildEnv.TAURI_ENV_DEBUG;
delete buildEnv.TAURI_ENV_PLATFORM;

const build = spawnSync(process.execPath, [viteEntry, "build", "--outDir", distDir], {
  cwd: root,
  env: buildEnv,
  encoding: "utf8",
});
assert.equal(
  build.status,
  0,
  `production Vite build failed:\n${build.stdout || ""}${build.stderr || ""}`,
);

try {
  await verifyBundleBudget(distDir);
} finally {
  await rm(distDir, { recursive: true, force: true });
}

async function verifyBundleBudget(distDir) {
  const html = await readFile(join(distDir, "index.html"), "utf8");
  const initialScripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g)]
    .map((match) => match[1])
    .filter((src) => src.startsWith("/assets/"))
    .map((src) => src.slice("/assets/".length));
  const preloadedScripts = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"[^>]*>/g)]
    .map((match) => match[1])
    .filter((src) => src.startsWith("/assets/"))
    .map((src) => src.slice("/assets/".length));

  assert.ok(initialScripts.length > 0, "production index.html must declare at least one initial JS asset");

  let initialBytes = 0;
  for (const file of initialScripts) {
    const fileStat = await stat(join(distDir, "assets", file));
    initialBytes += fileStat.size;
    assert.ok(
      !KNOWN_LAZY_CHUNK_PREFIXES.some((prefix) => basename(file).startsWith(prefix)),
      `lazy chunk ${file} must not be loaded by index.html`,
    );
  }

  for (const file of preloadedScripts) {
    assert.ok(
      !KNOWN_LAZY_CHUNK_PREFIXES.some((prefix) => basename(file).startsWith(prefix)),
      `lazy chunk ${file} must not be modulepreloaded by index.html`,
    );
  }

  assert.ok(
    initialBytes <= INITIAL_JS_BUDGET_BYTES,
    `initial JS ${initialBytes} bytes exceeds ${INITIAL_JS_BUDGET_BYTES} byte release budget`,
  );

  const assetFiles = await readdir(join(distDir, "assets"));
  for (const prefix of KNOWN_LAZY_CHUNK_PREFIXES) {
    assert.ok(
      assetFiles.some((file) => file.startsWith(prefix) && file.endsWith(".js")),
      `expected named lazy chunk with prefix ${prefix}`,
    );
  }
}
