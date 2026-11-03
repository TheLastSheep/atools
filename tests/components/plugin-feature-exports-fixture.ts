import * as fs from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";
import { createPluginFeatureExportsBridge } from "../../src/lib/pluginFeatureExportsBridge";

/** Full original CJS graph; fixture FS, process sink, and sync API transport only. */
export function exportsFixture(options: { stringify?: typeof JSON.stringify } = {}) {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const messages: Record<string, any>[] = [], timers: (() => void)[] = [];
  const storage = new Map<string, unknown>();
  let search: ((value: { text: string }) => void) | undefined;
  const parent = {};
  const api = {
    setSubInput: vi.fn((callback: typeof search, _placeholder?: string, _focus?: boolean) => { search = callback; }),
    setSubInputValue: vi.fn((text: string) => search?.({ text })),
    removeSubInput: vi.fn(), copyText: vi.fn(), outPlugin: vi.fn(), hideMainWindow: vi.fn(),
    showNotification: vi.fn(), shellOpenExternal: vi.fn(), onMainPush: vi.fn(), registerTool: vi.fn(),
    getPath: vi.fn(() => ""), dbStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: unknown) => storage.set(key, value) },
    db: { get: vi.fn(() => null) },
  };
  const target = { parent, console: { error: vi.fn() }, ztools: api, exports: {} as Record<string, any>,
    __ATOOLS_FRAME_TRANSPORT__: { post: (message: Record<string, unknown>) => messages.push(message), accept: (event: any) => event.accepted !== false },
    addEventListener(name: string, callback: (event: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: (event: unknown) => void) { handlers.get(name)?.delete(callback); },
    dispatchEvent(event: any) { for (const callback of [...handlers.get(event.type) ?? []]) callback(event); return true; },
  };
  class FixtureEvent { constructor(public type: string, public options?: any) {} }
  class FixtureCustomEvent extends FixtureEvent { detail: any; constructor(type: string, options?: any) { super(type, options); this.detail = options?.detail; } }
  const bridge = runInNewContext(`(${createPluginFeatureExportsBridge.toString()})(window, 7)`, {
    window: target, TextEncoder, JSON: { stringify: options.stringify ?? JSON.stringify },
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
    Event: FixtureEvent, CustomEvent: FixtureCustomEvent,
  }) as ReturnType<typeof createPluginFeatureExportsBridge>;
  const dispatch = (name: string, data: any = {}) => target.dispatchEvent({ type: name, ...data });
  const command = (index = 0, override: Record<string, unknown> = {}) => {
    const latest = messages.at(-1)!;
    dispatch("message", { source: parent, data: { __atools_feature_exports_command__: true, epoch: 7, entry: latest.entry,
      revision: latest.revision, command: "select", index, ...override } });
  };
  const loadOriginal = (entry: string, builtins: Record<string, unknown> = {}, processOptions: Record<string, unknown> = {}) => {
    const cache = new Map<string, { exports: any }>();
    function load(file: string): any {
      const filename = path.resolve(file);
      if (cache.has(filename)) return cache.get(filename)!.exports;
      const module = { exports: {} }; cache.set(filename, module);
      const require = (name: string) => {
        if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), name.endsWith(".js") ? name : name + ".js"));
        if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
        if (name === "fs") return fs;
        if (name === "path") return path;
        throw Error("Unapproved fixture module " + name);
      };
      runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, {
        window: target, console: target.console, process: { platform: "darwin", env: {}, ...processOptions }, Buffer, URL,
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
      }, { filename })(require, module, module.exports);
      return module.exports;
    }
    return load(entry);
  };
  return { target, bridge, messages, timers, handlers, api, storage, dispatch, command, loadOriginal,
    search: (text: string) => search?.({ text }), latestRows: () => [...messages].reverse().find(message => Array.isArray(message.rows))?.rows };
}
