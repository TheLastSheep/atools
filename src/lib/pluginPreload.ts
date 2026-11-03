import { analyzePluginSource, rewritePluginImports } from "./pluginSourceAnalysis";
import { pluginModuleImportsScript } from "./pluginModuleImports";
import { pluginModuleAdapterExpression } from "./pluginModuleAdapter";

export type PluginPreloadOptions = {
  pluginDir: string;
  preloadPath: string;
  readTextFile: (path: string) => Promise<string>;
  maxModules?: number;
  maxBytes?: number;
  maxReads?: number;
  maxDurationMs?: number;
  isCurrent?: () => boolean;
  onExternalRequire?: (specifier: string, source: string) => void;
  onModuleSource?: (source: string, kind?: "commonjs" | "esm") => void;
  onNodeModuleImportNeeded?: () => void;
};

type PreloadModule = { source: string; dependencies: [string, string | null][] };

/** Prefetch only literal relative CJS imports. Execution remains in the isolated frame. */
export async function preparePluginPreload(options: PluginPreloadOptions): Promise<string> {
  const root = normalizePath(options.pluginDir);
  const entry = normalizePath(options.preloadPath);
  assertInside(root, entry);
  const modules = new Map<string, PreloadModule>();
  const esmSources = new Map<string, string>();
  const reads = new Map<string, Promise<string | undefined>>();
  const maxModules = options.maxModules ?? 128;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxReads = options.maxReads ?? 1024;
  const maxDurationMs = options.maxDurationMs ?? 1000;
  const deadline = performance.now() + maxDurationMs;
  let hasImports = false;
  let bytes = 0;

  function checkCurrent(): void {
    if (options.isCurrent && !options.isCurrent()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    if (performance.now() >= deadline) throw new Error("ERR_ATOOLS_PRELOAD_TIMEOUT");
  }

  async function read(path: string): Promise<string | undefined> {
    checkCurrent();
    assertInside(root, path);
    const existing = reads.get(path);
    if (existing) return existing;
    if (reads.size >= maxReads) throw new Error(`ERR_ATOOLS_PRELOAD_BUDGET: ${maxReads} file reads`);
    const source = options.readTextFile(path).then((text) => {
      checkCurrent();
      bytes += new TextEncoder().encode(text).byteLength;
      if (bytes > maxBytes) throw new Error(`ERR_ATOOLS_PRELOAD_BUDGET: ${maxBytes} source bytes`);
      return text;
    }, (error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      if (code === "ENOENT" || code === "EISDIR" || /ERR_ATOOLS_PRELOAD_(?:NOT_FOUND|NOT_FILE)(?:\b|:)/.test(String(error))) return undefined;
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ERR_ATOOLS_PRELOAD_TIMEOUT")), Math.max(0, deadline - performance.now()));
    });
    const pending = Promise.race([source, timeout]).finally(() => clearTimeout(timer));
    reads.set(path, pending);
    return pending;
  }

  async function resolve(base: string, request: string): Promise<string | undefined> {
    const target = normalizePath(`${base}/${request}`);
    assertInside(root, target);
    // Native addons and ESM need their own runtime; never pretend they are CJS.
    if (/\.(?:node|mjs)$/i.test(target)) return undefined;
    for (const candidate of [target, `${target}.js`, `${target}.cjs`, `${target}.json`]) {
      if (await read(candidate) !== undefined) return candidate;
    }
    const packageSource = await read(`${target}/package.json`);
    if (packageSource !== undefined) {
      try {
        const main: unknown = JSON.parse(packageSource).main;
        if (typeof main === "string" && main && main !== "." && main !== "./") {
          const packageEntry = normalizePath(`${target}/${main}`);
          assertInside(root, packageEntry);
          if (/\.(?:node|mjs)$/i.test(packageEntry)) return undefined;
          for (const candidate of [packageEntry, `${packageEntry}.js`, `${packageEntry}.cjs`, `${packageEntry}.json`, `${packageEntry}/index.js`]) {
            if (await read(candidate) !== undefined) return candidate;
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    for (const candidate of [`${target}/index.js`, `${target}/index.cjs`, `${target}/index.json`]) {
      if (await read(candidate) !== undefined) return candidate;
    }
    return undefined;
  }

  async function prefetchImport(parent: string, request?: string): Promise<void> {
    hasImports = true;
    if (!request || (!request.startsWith("./") && !request.startsWith("../"))) {
      options.onNodeModuleImportNeeded?.(); return;
    }
    const target = normalizePath(`${dirname(parent)}/${request}`);
    assertInside(root, target);
    if (esmSources.has(target)) return;
    if (!/\.(?:m?js)$/i.test(target)) { options.onNodeModuleImportNeeded?.(); return; }
    if (modules.size + esmSources.size >= maxModules) throw new Error(`ERR_ATOOLS_PRELOAD_BUDGET: ${maxModules} modules`);
    const source = await read(target);
    if (source === undefined) { options.onNodeModuleImportNeeded?.(); return; }
    options.onModuleSource?.(source, "esm");
    esmSources.set(target, source);
  }

  async function visit(path: string): Promise<void> {
    checkCurrent();
    if (modules.has(path)) return;
    if (modules.size + esmSources.size >= maxModules) throw new Error(`ERR_ATOOLS_PRELOAD_BUDGET: ${maxModules} modules`);
    const source = await read(path);
    if (source === undefined) throw new Error(`ERR_ATOOLS_PRELOAD_NOT_FOUND: ${path}`);
    options.onModuleSource?.(source, "commonjs");
    const record: PreloadModule = { source, dependencies: [] };
    modules.set(path, record); // Cycles see the same module before walking dependencies.
    if (path.endsWith(".json")) return;
    const analysis = analyzePluginSource(source);
    for (const request of analysis.requires) {
      if (!request.startsWith("./") && !request.startsWith("../")) {
        options.onExternalRequire?.(request, source);
        continue;
      }
      const dependency = await resolve(dirname(path), request);
      record.dependencies.push([request, dependency ?? null]);
      if (dependency) await visit(dependency);
    }
    for (const call of analysis.imports) await prefetchImport(path, call.literal);
  }

  await visit(entry);
  checkCurrent();
  const definitions = [...modules].map(([path, record]) => {
    const source = path.endsWith(".json")
      ? `module.exports = JSON.parse(${JSON.stringify(record.source)});`
      : rewritePluginImports(record.source.replace(/^\uFEFF/, "").replace(/^#![^\r\n]*/, ""), path);
    return `[${JSON.stringify(path)}, function(require, module, exports, __filename, __dirname) {\n${source}\n}]`;
  }).join(",\n");
  const dependencies = JSON.stringify([...modules].map(([path, record]) => [path, record.dependencies]));
  const importSetup = hasImports ? pluginModuleImportsScript({ pluginDir: root, sources: [...esmSources],
    initialBytes: bytes, initialModules: modules.size + esmSources.size, initialReads: reads.size,
    maxBytes, maxModules, maxReads, maxDurationMs }) : "";
  const script = `(function() {
${importSetup}
var entry = ${JSON.stringify(entry)};
var definitions = new Map([${definitions}]);
var dependencies = new Map(${dependencies}.map(function(pair) { return [pair[0], new Map(pair[1])]; }));
var cache = new Map();
var hostRequire = window.require;
var moduleAdapter = ${pluginModuleAdapterExpression(root, "hostRequire")};
function missing(request, parent) {
  var error = new Error("ERR_ATOOLS_PRELOAD_MODULE_NOT_FOUND: " + request + " from " + parent);
  error.code = "MODULE_NOT_FOUND";
  return error;
}
function createRequire(parent) {
  function require(request) {
    if (typeof request !== 'string') throw new TypeError('CommonJS module name must be a string');
    if (request.startsWith('./') || request.startsWith('../')) {
      var id = dependencies.get(parent).get(request);
      if (!id) throw missing(request, parent);
      return load(id).exports;
    }
    if (typeof hostRequire !== 'function' && !moduleAdapter.canHandle(request)) throw missing(request, parent);
    return moduleAdapter(request);
  }
  require.resolve = function(request) {
    var id = dependencies.get(parent).get(request);
    if (!id) throw missing(request, parent);
    return id;
  };
  return require;
}
function load(id) {
  if (cache.has(id)) return cache.get(id);
  var module = { exports: {} };
  cache.set(id, module);
  try {
    definitions.get(id).call(module.exports, createRequire(id), module, module.exports, id, id.slice(0, id.lastIndexOf('/')));
    return module;
  } catch (error) { cache.delete(id); throw error; }
}
window.__filename = entry;
window.__dirname = entry.slice(0, entry.lastIndexOf('/'));
window.require = createRequire(entry);
var entryExports = load(entry).exports;
function closeModuleAdapter() {
  moduleAdapter.close();
  window.removeEventListener('pagehide', closeModuleAdapter);
  window.removeEventListener('atools-plugin-out', closeModuleAdapter);
}
if (typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', closeModuleAdapter, { once: true });
  window.addEventListener('atools-plugin-out', closeModuleAdapter, { once: true });
}
var preservePluginReadyFacades = !!(window.utools && window.ztools && window.ztools !== window.utools
  && Object.prototype.hasOwnProperty.call(window.utools, 'onPluginReady')
  && Object.prototype.hasOwnProperty.call(window.ztools, 'onPluginReady')
  && typeof window.utools.onPluginReady === 'function'
  && typeof window.ztools.onPluginReady === 'function'
  && window.utools.onPluginReady !== window.ztools.onPluginReady);
if (window.ztools && window.ztools !== window.utools) {
  try {
    if (preservePluginReadyFacades) {
      Reflect.ownKeys(window.ztools).forEach(function(key) {
        if (key === 'onPluginReady' || !Object.prototype.propertyIsEnumerable.call(window.ztools, key)) return;
        window.utools[key] = window.ztools[key];
      });
    } else Object.assign(window.utools, window.ztools);
  } catch (_) {}
}
if (!preservePluginReadyFacades) window.ztools = window.utools;
window.services = window.services || {};
if (entryExports && typeof entryExports === 'object') Object.assign(window.services, entryExports);
})();`;
  return `<script data-atools-plugin-preload="true">\n${script.replace(/<\/script/gi, "<\\/script")}\n</script>`;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const prefix = normalized.match(/^(?:[a-zA-Z]:)?\//)?.[0] ?? "";
  if (!prefix) throw new Error(`ERR_ATOOLS_PRELOAD_PATH: expected absolute path: ${value}`);
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return prefix + parts.join("/");
}

function dirname(value: string): string {
  return value.slice(0, value.lastIndexOf("/"));
}

function assertInside(root: string, path: string): void {
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`ERR_ATOOLS_PRELOAD_PATH_OUTSIDE_PLUGIN: ${path}`);
  }
}
