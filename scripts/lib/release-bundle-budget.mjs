import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const INITIAL_JS_BUDGET_BYTES = 560 * 1024;
const LAZY_PREFIXES = ["plugin-panel-", "pinyin-engine-"];

/** Follow static edges in Vite's bundler manifest, including shared dependencies.
 * HTML modulepreload filtering does not remove an ES module's static imports. */
export function initialJavaScriptGraph(manifest, roots) {
  const byFile = new Map(Object.entries(manifest).map(([key, item]) => [item.file, key]));
  const found = new Set();
  function visit(key, via) {
    const entry = manifest[key];
    assert.ok(entry, `Missing build manifest dependency ${key}`);
    const file = entry.file;
    assert.ok(typeof file === "string" && /^assets\/[^/]+\.js$/.test(file), `Invalid JavaScript asset ${file}`);
    if (found.has(file)) return;
    assert.ok(!LAZY_PREFIXES.some(prefix => basename(file).startsWith(prefix)),
      `Lazy chunk is reachable by an initial static import: ${[...via, file].join(" -> ")}`);
    found.add(file);
    for (const dependency of entry.imports ?? []) visit(dependency, [...via, file]);
  }
  for (const file of roots) {
    const key = byFile.get(file);
    assert.ok(key, `Initial asset ${file} is absent from the build manifest`);
    visit(key, []);
  }
  return [...found].sort();
}

const JS_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+\.js$/;

/** Collect one entry's transitive Vite `imports` graph; dynamicImports and CSS are not part of this metric. */
export function lazyJavaScriptGraph(manifest, rootKey) {
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Invalid Vite manifest");
  const visitedKeys = new Set();
  const foundFiles = new Set();
  function visit(key, via) {
    assert.ok(typeof key === "string" && Object.hasOwn(manifest, key),
      `Missing build manifest dependency ${String(key)}${via.length ? ` via ${via.join(" -> ")}` : ""}`);
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);
    const entry = manifest[key];
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `Invalid build manifest entry ${key}`);
    const file = entry.file;
    assert.ok(typeof file === "string" && JS_ASSET_PATH.test(file), `Invalid JavaScript asset ${String(file)}`);
    foundFiles.add(file);
    const imports = entry.imports ?? [];
    assert.ok(Array.isArray(imports), `Invalid static imports for ${key}`);
    for (const dependency of imports) visit(dependency, [...via, file]);
  }
  visit(rootKey, []);
  return [...foundFiles].sort();
}

/** Partition a deduplicated Vite JS closure by its overlap with the initial static graph. */
export function summarizeLazyJavaScriptGraph(lazyFiles, initialFiles, sizesByFile) {
  assert.ok(Array.isArray(lazyFiles) && lazyFiles.length > 0, "Lazy JavaScript closure must not be empty");
  assert.ok(Array.isArray(initialFiles) || initialFiles instanceof Set, "Initial JavaScript files must be a set or array");
  assert.ok(sizesByFile && typeof sizesByFile === "object", "Lazy JavaScript sizes are required");
  const files = [...new Set(lazyFiles)];
  assert.equal(files.length, lazyFiles.length, "Lazy JavaScript closure must be deduplicated by file");
  for (const file of files) assert.ok(typeof file === "string" && JS_ASSET_PATH.test(file), `Invalid JavaScript asset ${String(file)}`);
  files.sort();
  const initial = new Set(initialFiles);
  const sizeOf = file => {
    assert.ok(Object.hasOwn(sizesByFile, file), `Missing emitted JavaScript size for ${file}`);
    const bytes = sizesByFile[file];
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, `Invalid emitted JavaScript size for ${file}`);
    return bytes;
  };
  const entries = files.map(file => ({ file, bytes: sizeOf(file) }));
  const sharedWithInitial = entries.filter(entry => initial.has(entry.file));
  const exclusiveToLazy = entries.filter(entry => !initial.has(entry.file));
  const total = values => values.reduce((sum, entry) => {
    const next = sum + entry.bytes;
    assert.ok(Number.isSafeInteger(next), "JavaScript closure byte total exceeds safe integer range");
    return next;
  }, 0);
  return {
    metric: "static_closure",
    unit: "uncompressed_emitted_js_bytes",
    scope: "Vite manifest imports only; dynamicImports, CSS, and non-JavaScript assets are excluded. This is not total runtime memory or RSS.",
    assets: entries,
    totalBytes: total(entries),
    sharedWithInitial: { assets: sharedWithInitial, bytes: total(sharedWithInitial) },
    exclusiveToLazy: { assets: exclusiveToLazy, bytes: total(exclusiveToLazy) },
  };
}

export async function verifyBundleBudget(distDir) {
  const [html, manifestText, assetFiles] = await Promise.all([
    readFile(join(distDir, "index.html"), "utf8"),
    readFile(join(distDir, ".vite", "manifest.json"), "utf8"),
    readdir(join(distDir, "assets")),
  ]);
  const localAsset = value => value.startsWith("/assets/") ? value.slice(1) : null;
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g)]
    .map(match => localAsset(match[1])).filter(Boolean);
  const preloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"[^>]*>/g)]
    .map(match => localAsset(match[1])).filter(Boolean);
  assert.ok(scripts.length > 0, "Production index.html must declare an initial JS asset");
  const initialAssets = initialJavaScriptGraph(JSON.parse(manifestText), [...scripts, ...preloads]);
  const sizes = await Promise.all(initialAssets.map(async file => ({ file, bytes: (await stat(join(distDir, file))).size })));
  const initialJavaScriptBytes = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(initialJavaScriptBytes <= INITIAL_JS_BUDGET_BYTES,
    `Initial JS graph ${initialJavaScriptBytes} bytes exceeds ${INITIAL_JS_BUDGET_BYTES} byte release budget`);
  for (const prefix of LAZY_PREFIXES) {
    assert.ok(assetFiles.some(file => file.startsWith(prefix) && file.endsWith(".js")), `Expected lazy chunk ${prefix}`);
  }
  return { initialJavaScriptBytes, budgetBytes: INITIAL_JS_BUDGET_BYTES, initialAssets: sizes,
    graphSource: "Vite manifest static imports plus HTML entry/preload roots", lazyPrefixesExcluded: LAZY_PREFIXES };
}
