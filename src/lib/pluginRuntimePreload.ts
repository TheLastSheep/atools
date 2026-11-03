import { selectedNodePreloadAnchor } from "./pluginNodeSelectedPreload";
import { createPluginLegacyNodeEnvironment } from "./pluginLegacyNodeEnvironment";
import { preparePluginPreload, type PluginPreloadOptions } from "./pluginPreload";
import { analyzePluginSource } from "./pluginSourceAnalysis";
import { analyzePluginNativePathUsage, type PluginNativePathUsage } from "./pluginNativePathUsage";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type PluginRuntimePreloadOptions = Omit<PluginPreloadOptions, "onExternalRequire" | "onModuleSource" | "onNodeModuleImportNeeded"> & {
  onSafeStorageRequired?: () => Promise<void>;
  onFileDragRequired?: () => Promise<void>;
};
type PageUsage = { usage: "detected" | "not_detected" | "unknown"; requiresNode: boolean; entryMode: "preload" | "page" | null };

/** One loader owns one panel generation, including a pending permission request. */
export function createPluginRuntimePreload(
  invoke: Invoke,
  pluginId: string,
  isCurrent: () => boolean,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 200)),
  fixedInstanceId?: string,
) {
  const nodeEnvironment = createPluginLegacyNodeEnvironment(invoke, pluginId, isCurrent, wait, fixedInstanceId);
  let closed = false;
  let preparedNodeEnvironment: Promise<string> | undefined;

  function assertCurrent() {
    if (closed || !isCurrent()) {
      void close();
      throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    }
  }

  function close() {
    closed = true;
    return nodeEnvironment.close();
  }

  function closeStrict() {
    closed = true;
    return nodeEnvironment.closeStrict();
  }

  function prepareNodeEnvironment(selectedPreload?: string) {
    assertCurrent();
    return preparedNodeEnvironment ??= nodeEnvironment.prepare(selectedPreload);
  }

  async function preparePage(): Promise<string> {
    try {
      assertCurrent();
      let usage: PageUsage;
      try {
        usage = await invoke<PageUsage>("plugin_legacy_node_usage", { pluginId });
      } catch {
        // An unavailable or failed analysis is unknown, so it cannot start Node.
        assertCurrent();
        return "";
      }
      assertCurrent();
      if (!isTrustedPageNodeUsage(usage)) return "";
      return await prepareNodeEnvironment();
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function prepareGraph(options: PluginRuntimePreloadOptions, additional = false): Promise<string> {
    const current = () => !closed && isCurrent() && (options.isCurrent?.() ?? true);
    assertCurrent();
    if (!current()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    let needsNode = false;
    let needsSafeStorage = false;
    let needsFileDrag = false;
    let sawElectron = false;
    const pathUsage = new Map<string, PluginNativePathUsage>();
    const graphSources = new Set<string>();
    let skippedPathPreparation = false;
    const nativePathRoot = options.pluginDir.startsWith("/");
    function pathSourceUsage(source: string) {
      let usage = pathUsage.get(source);
      if (!usage) { usage = analyzePluginNativePathUsage(source); pathUsage.set(source, usage); }
      return usage;
    }
    const preload = await preparePluginPreload({
      ...options,
      isCurrent: current,
      onExternalRequire: (specifier, source) => {
        if (specifier === "electron") { sawElectron = true; return; }
        if (nativePathRoot && ["path", "node:path", "path/posix", "node:path/posix"].includes(specifier)) {
          if (pathSourceUsage(source).kind === "safe") { skippedPathPreparation = true; return; }
        }
        needsNode = true;
      },
      onModuleSource: (source, kind) => {
        graphSources.add(source);
        if (/\bstartDrag\b/.test(source)) needsFileDrag = true;
        if (kind === "esm") {
          const analysis = analyzePluginSource(source, { includeModuleSpecifiers: true });
          if (analysis.requires.includes("electron")
            || analysis.moduleSpecifiers?.some(specifier => specifier.value === "electron")) {
            throw new Error("ERR_ATOOLS_ESM_ELECTRON_UNSUPPORTED");
          }
          if (/\bwindow\s*\.\s*__atoolsNodeModuleRequire\s*\(\s*(['"])electron\1\s*\)/.test(source)) {
            needsNode = true;
            sawElectron = true;
          }
        }
        if (/\bsafeStorage\b/.test(source)) needsSafeStorage = true;
        if (/\belectron\b/.test(source) && /\bsafeStorage\b/.test(source)) sawElectron = true;
      },
      onNodeModuleImportNeeded: () => { needsNode = true; },
    });
    // The old path import supplied Node globals to sibling modules too. Every
    // source in this graph must be proven local before removing that environment.
    if (skippedPathPreparation && !needsNode) {
      needsNode = [...graphSources].some(source => pathSourceUsage(source).kind !== "safe");
    }
    assertCurrent();
    if (!current()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    if (sawElectron && needsSafeStorage) {
      if (additional) throw new Error("ERR_ATOOLS_SECRET_STORAGE_CHILD_UNSUPPORTED");
      if (!options.onSafeStorageRequired) throw new Error("ERR_ATOOLS_SECRET_STORAGE_UNAVAILABLE");
      await options.onSafeStorageRequired();
      assertCurrent();
      if (!current()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    }
    if (needsFileDrag && !additional && options.onFileDragRequired) {
      try { await options.onFileDragRequired(); }
      catch { console.warn("Plugin file drag preparation failed; startDrag remains unavailable"); }
      assertCurrent();
      if (!current()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    }
    if (!needsNode) return preload;
    const environment = await prepareNodeEnvironment(additional ? selectedNodePreloadAnchor(options) : undefined);
    assertCurrent();
    if (!current()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    return `${environment}${preload}`;
  }

  async function prepare(options: PluginRuntimePreloadOptions): Promise<string> {
    try {
      return await prepareGraph(options);
    } catch (error) {
      await close();
      throw error;
    }
  }

  // Child graphs share the panel's authorized environment. A missing or stale
  // child graph must not tear down an already active parent Node session.
  return { prepare, prepareAdditional: (options: PluginRuntimePreloadOptions) => prepareGraph(options, true), preparePage, close, closeStrict };
}

function isTrustedPageNodeUsage(value: unknown): value is PageUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<PageUsage>;
  return usage.usage === "detected" && usage.requiresNode === true && usage.entryMode === "page";
}
