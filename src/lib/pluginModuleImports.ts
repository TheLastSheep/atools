import { analyzePluginSource, type PluginSourceAnalysis } from "./pluginSourceAnalysis";

export type PluginModuleImportConfig = {
  pluginDir: string;
  sources: [string, string][];
  initialBytes: number;
  initialModules: number;
  initialReads: number;
  maxBytes: number;
  maxModules: number;
  maxReads: number;
  maxDurationMs: number;
};
export type PluginModuleImporter = {
  (parent: string, specifier: unknown, options?: unknown): Promise<any>;
  close: () => void;
};

export function pluginModuleImportsScript(config: PluginModuleImportConfig): string {
  const encoded = JSON.stringify(config).replace(/</g, "\\u003c");
  return `window.__atoolsImportModule=(${makePluginModuleImports.toString()})(${encoded},${analyzePluginSource.toString()});`;
}

/** Keep self-contained: this function executes in the opaque plugin frame. */
export function makePluginModuleImports(
  config: PluginModuleImportConfig,
  analyze: (source: string) => PluginSourceAnalysis = analyzePluginSource,
  importBlob: (url: string) => Promise<any> = (url) => import(/* @vite-ignore */ url),
): PluginModuleImporter {
  const sources = new Map(config.sources);
  const cache = new Map<string, Promise<any>>();
  const aliases = new Map<string, string>();
  const urls = new Set<string>();
  const pending = new Set<(error: Error) => void>();
  let bytes = config.initialBytes, modules = config.initialModules, reads = config.initialReads;
  let closed = false;
  function failure(code: string): Error {
    return Object.assign(new Error(code), { code });
  }
  function normalize(value: string): string {
    const path = value.replace(/\\/g, "/");
    const prefix = path.match(/^(?:[a-z]:)?\//i)?.[0];
    if (!prefix) throw failure("ERR_ATOOLS_ESM_ABSOLUTE_PATH_REQUIRED");
    const parts: string[] = [];
    for (const part of path.slice(prefix.length).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop(); else parts.push(part);
    }
    return prefix + parts.join("/");
  }
  const root = normalize(config.pluginDir).replace(/\/$/, "");
  function inside(path: string, base = root): void {
    if (!path.startsWith(base + "/")) throw failure("ERR_ATOOLS_ESM_OUTSIDE_PLUGIN");
  }
  function check(deadline: number): void {
    if (closed) throw failure("ERR_ATOOLS_ESM_CLOSED");
    if (performance.now() >= deadline) throw failure("ERR_ATOOLS_ESM_TIMEOUT");
    if (bytes > config.maxBytes || modules > config.maxModules || reads > config.maxReads) throw failure("ERR_ATOOLS_ESM_BUDGET");
  }
  function readBudget(deadline: number): void { reads++; check(deadline); }
  function nodeRequire(): any {
    const require = (globalThis as any).window?.__atoolsNodeModuleRequire;
    if (typeof require !== "function") throw failure("ERR_ATOOLS_ESM_REQUIRES_AUTHORIZED_NODE");
    return require;
  }
  function resolve(parent: string, specifier: unknown, deadline: number): { id: string; fs?: any; require?: any } {
    check(deadline);
    if (typeof specifier !== "string" || !specifier || specifier.length > 4096 || /[\0?#]/.test(specifier)) throw failure("ERR_ATOOLS_ESM_INVALID_SPECIFIER");
    if (/^[a-z][a-z\d+.-]*:/i.test(specifier) && !/^file:/i.test(specifier) && !/^[a-z]:[\\/]/i.test(specifier)) {
      throw failure("ERR_ATOOLS_ESM_NETWORK_OR_BUILTIN_UNSUPPORTED");
    }
    const normalizedParent = normalize(parent); inside(normalizedParent);
    let path: string | undefined;
    if (specifier.startsWith("./") || specifier.startsWith("../")) path = normalize(normalizedParent.slice(0, normalizedParent.lastIndexOf("/")) + "/" + specifier);
    else if (/^(?:[a-z]:)?\//i.test(specifier)) path = normalize(specifier);
    if (path) {
      inside(path);
      if (!/\.(?:m?js)$/i.test(path)) throw failure("ERR_ATOOLS_ESM_FILE_TYPE_UNSUPPORTED");
      if (sources.has(path)) return { id: path };
    }
    readBudget(deadline);
    const require = nodeRequire(), fs = require("node:fs"), pathApi = require("node:path");
    check(deadline);
    const canonicalRoot = normalize(fs.realpathSync(config.pluginDir));
    const canonicalParent = normalize(fs.realpathSync(normalizedParent)); inside(canonicalParent, canonicalRoot);
    if (/^file:/i.test(specifier)) {
      const url = new URL(specifier);
      if (url.host && url.host !== "localhost") throw failure("ERR_ATOOLS_ESM_NETWORK_OR_BUILTIN_UNSUPPORTED");
      path = require("node:url").fileURLToPath(specifier);
    }
    const resolver = require("node:module").createRequire(canonicalParent);
    const resolved = resolver.resolve(path || specifier);
    const canonical = normalize(fs.realpathSync(resolved)); inside(canonical, canonicalRoot);
    if (![".js", ".mjs"].includes(pathApi.extname(canonical).toLowerCase())) throw failure("ERR_ATOOLS_ESM_FILE_TYPE_UNSUPPORTED");
    check(deadline);
    return { id: canonical, fs, require };
  }
  async function readSource(id: string, fs: any, require: any, deadline: number): Promise<string> {
    const metadata = (value: any) => ({ dev: value.dev, ino: value.ino, size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs, file: value.isFile() });
    const same = (a: ReturnType<typeof metadata>, b: ReturnType<typeof metadata>) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
    const constants = fs.constants;
    const fd = fs.openSync(id, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    let callback: Function | undefined;
    try {
      check(deadline);
      const before = metadata(fs.fstatSync(fd));
      if (!before.file) throw failure("ERR_ATOOLS_ESM_NOT_FILE");
      if (before.size > config.maxBytes - bytes) throw failure("ERR_ATOOLS_ESM_BUDGET");
      // Reserve before the first await: concurrent imports share one byte ceiling.
      bytes += before.size; check(deadline);
      const remaining = before.size;
      if (!same(before, metadata(fs.statSync(id)))) throw failure("ERR_ATOOLS_ESM_SOURCE_CHANGED");
      const chunks: Uint8Array[] = []; let count = 0;
      while (count <= remaining) {
        readBudget(deadline);
        const length = Math.min(64 * 1024, remaining - count + 1);
        const result: { size: number; buffer: Uint8Array } = await new Promise((resolveRead, reject) => {
          callback = (error: Error | null, size: number, buffer: Uint8Array) => error ? reject(error) : resolveRead({ size, buffer });
          fs.read(fd, new Uint8Array(length), 0, length, count, callback);
        });
        require.releaseCallbacks(callback); callback = undefined;
        check(deadline); count += result.size;
        if (count > remaining) throw failure("ERR_ATOOLS_ESM_BUDGET");
        chunks.push(result.buffer.subarray(0, result.size));
        if (result.size < length) break;
      }
      const after = metadata(fs.fstatSync(fd));
      if (!same(before, after) || normalize(fs.realpathSync(id)) !== id || !same(after, metadata(fs.statSync(id)))) throw failure("ERR_ATOOLS_ESM_SOURCE_CHANGED");
      check(deadline);
      const data = new Uint8Array(count); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } finally {
      if (callback) require.releaseCallbacks(callback);
      fs.closeSync(fd);
    }
  }
  function releaseUrl(url?: string): void {
    if (url && urls.delete(url)) URL.revokeObjectURL(url);
  }
  async function compile(id: string, fs: any, require: any, deadline: number, resource: { url?: string }): Promise<any> {
    const known = sources.get(id);
    if (known === undefined) { modules++; check(deadline); }
    const source = known ?? await readSource(id, fs, require, deadline);
    check(deadline);
    const syntax = analyze(source);
    if (syntax.staticDependencies) throw failure("ERR_ATOOLS_ESM_STATIC_DEPENDENCIES_UNSUPPORTED");
    if (syntax.importMeta) throw failure("ERR_ATOOLS_ESM_IMPORT_META_UNSUPPORTED");
    if (syntax.imports.length) throw failure("ERR_ATOOLS_ESM_NESTED_IMPORT_UNSUPPORTED");
    if (syntax.requires.length) throw failure("ERR_ATOOLS_ESM_REQUIRE_UNSUPPORTED");
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    urls.add(url); resource.url = url;
    try { const namespace = await importBlob(url); check(deadline); return namespace; }
    catch (error) { releaseUrl(url); throw error; }
  }
  const importer = ((parent: string, specifier: unknown, options?: unknown) => {
    let id: string;
    try {
      if (options !== undefined) throw failure("ERR_ATOOLS_ESM_IMPORT_OPTIONS_UNSUPPORTED");
      const deadline = performance.now() + config.maxDurationMs;
      check(deadline);
      const alias = `${parent}\0${typeof specifier === "string" ? specifier : ""}`;
      const previous = aliases.get(alias); if (previous && cache.has(previous)) return cache.get(previous)!;
      const resolved = resolve(parent, specifier, deadline); id = resolved.id;
      const existing = cache.get(id); if (existing) return existing;
      if (resolved.fs && aliases.size < config.maxModules) aliases.set(alias, id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectPending!: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => {
        rejectPending = reject; pending.add(reject);
        timer = setTimeout(() => reject(failure("ERR_ATOOLS_ESM_TIMEOUT")), Math.max(0, deadline - performance.now()));
      });
      const resource: { url?: string } = {};
      const loading = Promise.race([compile(id, resolved.fs, resolved.require, deadline, resource), interrupted])
        .catch(error => { releaseUrl(resource.url); if (cache.get(id) === loading) cache.delete(id); throw error; })
        .finally(() => { clearTimeout(timer); pending.delete(rejectPending); });
      cache.set(id, loading); return loading;
    } catch (error) { return Promise.reject(error); }
  }) as PluginModuleImporter;
  importer.close = () => {
    if (closed) return; closed = true;
    for (const reject of pending) reject(failure("ERR_ATOOLS_ESM_CLOSED"));
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); cache.clear(); aliases.clear(); sources.clear(); pending.clear();
    (globalThis as any).window?.removeEventListener("pagehide", importer.close);
  };
  (globalThis as any).window?.addEventListener("pagehide", importer.close, { once: true });
  return importer;
}
