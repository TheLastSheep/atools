export type PluginApiStandinEntry = {
  surface: string;
  property: string;
  count: number;
};

export type PluginApiStandinReport = {
  totalUnknownReads: number;
  entries: PluginApiStandinEntry[];
  overflowed: boolean;
};

export type PluginApiStandinController = {
  observeObject: <T extends object>(surface: string, target: T | null | undefined, nestedKeys?: readonly string[]) => T | null | undefined;
  recordUnknownRead: (surface: string, property: string) => void;
  getReport: () => PluginApiStandinReport;
  reset: () => void;
};

/**
 * Installs a zero-overhead prototype-chain stand-in probe inspired by craft-anything's `web_standin_show`.
 * Known own properties on `utools`, `ztools`, and `electron` resolve directly without hitting the Proxy trap;
 * only unknown property lookups reach the prototype trap and are recorded in a bounded ledger.
 */
export function createPluginApiStandinProbe(maxEntries = 128): PluginApiStandinController {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 128;
  const ledger = new Map<string, PluginApiStandinEntry>();
  const instrumented = new WeakSet<object>();
  let totalUnknownReads = 0;
  let overflowed = false;

  const ignoredProperties = new Set([
    "then",
    "catch",
    "finally",
    "toJSON",
    "valueOf",
    "toString",
    "toLocaleString",
    "constructor",
    "prototype",
    "__proto__",
    "__esModule",
    "$$typeof",
    "nodeType",
    "tagName",
    "default",
    " inspect",
    "inspect",
  ]);

  function shouldIgnore(property: string): boolean {
    if (!property || ignoredProperties.has(property)) return true;
    if (property.startsWith("__") || property.startsWith("@@")) return true;
    return false;
  }

  function recordUnknownRead(surface: string, property: string): void {
    if (typeof surface !== "string" || typeof property !== "string") return;
    if (shouldIgnore(property)) return;
    totalUnknownReads += 1;
    const key = `${surface}.${property}`;
    const existing = ledger.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (ledger.size >= limit) {
      overflowed = true;
      return;
    }
    ledger.set(key, {
      surface,
      property,
      count: 1,
    });
  }

  function observeObject<T extends object>(
    surface: string,
    target: T | null | undefined,
    nestedKeys: readonly string[] = [],
  ): T | null | undefined {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      return target;
    }
    for (const key of nestedKeys) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        const child = (target as Record<string, unknown>)[key];
        if (child && typeof child === "object") {
          observeObject(`${surface}.${key}`, child as object);
        }
      }
    }

    if (!instrumented.has(target)) {
      instrumented.add(target);
      const baseProto = Object.getPrototypeOf(target) || Object.prototype;
      const protoProxy = new Proxy(baseProto, {
        get(proto, prop, receiver) {
          if (typeof prop === "string" && !(prop in proto) && !Object.prototype.hasOwnProperty.call(target, prop)) {
            recordUnknownRead(surface, prop);
          }
          return Reflect.get(proto, prop, receiver);
        },
      });
      try {
        Object.setPrototypeOf(target, protoProxy);
      } catch {
        // Non-extensible or frozen host objects safely skip prototype instrumentation.
      }
    }

    return target;
  }

  function getReport(): PluginApiStandinReport {
    return {
      totalUnknownReads,
      entries: Array.from(ledger.values()).map((item) => ({ ...item })),
      overflowed,
    };
  }

  function reset(): void {
    ledger.clear();
    totalUnknownReads = 0;
    overflowed = false;
  }

  return {
    observeObject,
    recordUnknownRead,
    getReport,
    reset,
  };
}

export function installWindowPluginApiStandinProbe(targetWindow: Window & typeof globalThis): PluginApiStandinController {
  const existing = (targetWindow as unknown as Record<string, unknown>).__atoolsApiStandinProbe as
    | PluginApiStandinController
    | undefined;
  const controller = existing ?? createPluginApiStandinProbe(128);

  const utoolsNested = ["db", "dbStorage", "dbCryptoStorage", "ai", "providers", "ubrowser"] as const;
  const utoolsObj = (targetWindow as unknown as Record<string, unknown>).utools as Record<string, unknown> | undefined;
  if (utoolsObj && typeof utoolsObj === "object") {
    controller.observeObject("utools", utoolsObj, utoolsNested);
    if (!Object.prototype.hasOwnProperty.call(utoolsObj, "__atoolsGetApiStandinReport")) {
      Object.defineProperty(utoolsObj, "__atoolsGetApiStandinReport", {
        enumerable: false,
        configurable: true,
        value: () => controller.getReport(),
      });
    }
  }

  const ztoolsObj = (targetWindow as unknown as Record<string, unknown>).ztools as Record<string, unknown> | undefined;
  if (ztoolsObj && typeof ztoolsObj === "object") {
    controller.observeObject("ztools", ztoolsObj);
  }

  const localRequire = (targetWindow as unknown as Record<string, unknown>).require;
  if (typeof localRequire === "function") {
    try {
      const electronObj = (localRequire as (spec: string) => unknown)("electron");
      if (electronObj && typeof electronObj === "object") {
        controller.observeObject("electron", electronObj as object, [
          "ipcRenderer",
          "shell",
          "clipboard",
          "nativeImage",
          "webFrame",
          "safeStorage",
          "nativeTheme",
          "desktopCapturer",
          "webUtils",
          "screen",
        ]);
      }
    } catch {
      // Electron adapter not installed in this context.
    }
  }

  Object.defineProperty(targetWindow, "__atoolsApiStandinProbe", {
    enumerable: false,
    configurable: true,
    value: controller,
  });
  Object.defineProperty(targetWindow, "__atoolsGetApiStandinReport", {
    enumerable: false,
    configurable: true,
    value: () => controller.getReport(),
  });

  return controller;
}

export function pluginApiStandinProbeScript(): string {
  return [
    "<script data-atools-api-standin-probe>",
    "(function(){",
    "var createPluginApiStandinProbe=(" + createPluginApiStandinProbe.toString() + ");",
    "var installWindowPluginApiStandinProbe=(" + installWindowPluginApiStandinProbe.toString() + ");",
    "installWindowPluginApiStandinProbe(window);",
    "})();",
    "<\/script>",
  ].join("\n");
}
