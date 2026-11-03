export type PluginNativeCssRewrite = (css: string, mode?: "stylesheet" | "declarations") => string;

type NativeWindowSelf = {
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};
type NativeCssTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type NativeCssOptions = {
  windowType: string;
  hostKind: string;
  self?: NativeWindowSelf | null;
  rewrite: PluginNativeCssRewrite;
  reportError?: (error: unknown) => unknown;
};
type AnyDescriptor = PropertyDescriptor & { value?: (...args: unknown[]) => unknown };
type CssConstructor = { prototype: Record<string, unknown> };

/** Installs synchronous CSSOM translation for native BrowserWindow documents only. */
export function createPluginNativeAppRegionCssRuntime(target: NativeCssTarget, options: NativeCssOptions) {
  const candidate = options.self;
  const noop = () => undefined;
  if (options.windowType !== "browserWindow" || options.hostKind !== "native" || !candidate
    || typeof candidate.isDestroyed !== "function" || typeof candidate.on !== "function" || typeof candidate.off !== "function"
    || typeof options.rewrite !== "function") return { dispose: noop };
  const self: NativeWindowSelf = candidate;
  const privateAppRegionProperty = "--atools-native-app-region";

  const constructors = target as unknown as {
    CSSStyleSheet?: CssConstructor;
    CSSGroupingRule?: CssConstructor;
    CSSStyleDeclaration?: CssConstructor;
  };
  const sheetProto = constructors.CSSStyleSheet?.prototype;
  const groupingProto = constructors.CSSGroupingRule?.prototype;
  const styleProto = constructors.CSSStyleDeclaration?.prototype;
  if (!sheetProto && !groupingProto && !styleProto) return { dispose: noop };

  let active = true;
  const restorers: Array<() => void> = [];
  function report(error: unknown) {
    try {
      const result = options.reportError?.(error) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => undefined);
    } catch { /* CSS compatibility must not be interrupted by diagnostics. */ }
  }
  function rewrite(source: unknown, mode: "stylesheet" | "declarations") {
    const css = String(source ?? "");
    if (!active) return css;
    try { return options.rewrite(css, mode); }
    catch (error) { report(error); return css; }
  }
  function restore(proto: Record<string, unknown>, name: string, installed: PropertyDescriptor, original?: PropertyDescriptor) {
    const current = Object.getOwnPropertyDescriptor(proto, name);
    if (!current || current.value !== installed.value || current.get !== installed.get || current.set !== installed.set) return;
    try {
      if (original) Object.defineProperty(proto, name, original);
      else delete proto[name];
    } catch (error) { report(error); }
  }
  function patchMethod(proto: Record<string, unknown> | undefined, name: string, wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown) {
    if (!proto) return;
    const original = Object.getOwnPropertyDescriptor(proto, name) as AnyDescriptor | undefined;
    if (typeof original?.value !== "function") return;
    const installed = { ...original, value: wrap(original.value) };
    try {
      Object.defineProperty(proto, name, installed);
      restorers.push(() => restore(proto, name, installed, original));
    } catch (error) { report(error); }
  }
  function mappedPropertyName(rawName: unknown) {
    const name = String(rawName ?? "");
    if (!active) return name;
    const normalized = name.toLowerCase();
    if (normalized === "-webkit-app-region" || normalized === "app-region") {
      return privateAppRegionProperty;
    }
    return name;
  }
  function legacyPropertyName(rawName: unknown) {
    const normalized = String(rawName ?? "").toLowerCase();
    return normalized === "-webkit-app-region" || normalized === "app-region" ? normalized : undefined;
  }
  function hasTopLevelDelimiter(value: string) {
    let quote = "", parentheses = 0, brackets = 0;
    for (let index = 0; index < value.length; index++) {
      const char = value[index] ?? "";
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "/" && value[index + 1] === "*") {
        const close = value.indexOf("*/", index + 2);
        if (close < 0) return true;
        index = close + 1;
        continue;
      }
      if (char === "\\") { index++; continue; }
      if (char === "\"" || char === "'") { quote = char; continue; }
      if (char === "(") { parentheses++; continue; }
      if (char === ")" && parentheses > 0) { parentheses--; continue; }
      if (char === "[") { brackets++; continue; }
      if (char === "]" && brackets > 0) { brackets--; continue; }
      if (!parentheses && !brackets && (char === ";" || char === "{" || char === "}")) return true;
    }
    return Boolean(quote || parentheses || brackets);
  }
  function isSupportedLegacySetterValue(property: string, text: string, priority: unknown) {
    if (hasTopLevelDelimiter(text)) return false;
    const priorityText = priority == null ? "" : String(priority);
    const probe = `${property}: ${text}${priorityText ? ` !${priorityText}` : ""};`;
    const expected = probe.replace(property, privateAppRegionProperty);
    return rewrite(probe, "declarations") === expected;
  }
  function patchCssText(proto: Record<string, unknown> | undefined) {
    if (!proto) return;
    const original = Object.getOwnPropertyDescriptor(proto, "cssText");
    if (!original?.set) return;
    const installed: PropertyDescriptor = {
      ...original,
      set(this: unknown, value: unknown) {
        original.set!.call(this, rewrite(value, "declarations"));
      },
    };
    try {
      Object.defineProperty(proto, "cssText", installed);
      restorers.push(() => restore(proto, "cssText", installed, original));
    } catch (error) { report(error); }
  }
  function patchCamelCaseAlias(proto: Record<string, unknown> | undefined, name: "webkitAppRegion" | "appRegion") {
    if (!proto) return;
    const original = Object.getOwnPropertyDescriptor(proto, name);
    if (original?.configurable === false) return;
    const property = name === "webkitAppRegion" ? "-webkit-app-region" : "app-region";
    const installed: PropertyDescriptor = {
      configurable: true,
      enumerable: original?.enumerable ?? false,
      get(this: { getPropertyValue?: (name: string) => string }) {
        return this.getPropertyValue?.(active ? privateAppRegionProperty : property) ?? "";
      },
      set(this: { setProperty?: (name: string, value: string) => unknown }, value: unknown) {
        if (active) this.setProperty?.(property, value as string);
        else if (original?.set) original.set.call(this, value);
      },
    };
    try {
      Object.defineProperty(proto, name, installed);
      restorers.push(() => restore(proto, name, installed, original));
    } catch (error) { report(error); }
  }
  function dispose() {
    if (!active) return;
    active = false;
    try { target.removeEventListener("pagehide", dispose); } catch (error) { report(error); }
    try { target.removeEventListener("atools-plugin-out", dispose); } catch (error) { report(error); }
    try { self.off("closed", onSelfClosed); } catch (error) { report(error); }
    restorers.reverse().forEach(restoreOne => restoreOne());
    restorers.length = 0;
  }
  function onSelfClosed() { dispose(); }
  function isDestroyed() {
    try { return self.isDestroyed() === true; }
    catch (error) { report(error); return true; }
  }

  patchMethod(sheetProto, "insertRule", original => function(this: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = rewrite(args[0], "stylesheet");
    return original.apply(this, args);
  });
  patchMethod(groupingProto, "insertRule", original => function(this: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = rewrite(args[0], "stylesheet");
    return original.apply(this, args);
  });
  patchMethod(sheetProto, "replace", original => function(this: unknown, source: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = rewrite(source, "stylesheet");
    return original.apply(this, args);
  });
  patchMethod(sheetProto, "replaceSync", original => function(this: unknown, source: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = rewrite(source, "stylesheet");
    return original.apply(this, args);
  });
  patchMethod(styleProto, "setProperty", original => function(this: unknown, name: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 2) return original.apply(this, args);
    const legacyProperty = legacyPropertyName(name);
    if (!legacyProperty) return original.apply(this, args);
    if (args[1] == null) {
      args[0] = privateAppRegionProperty;
      args[1] = "";
    } else {
      const text = String(args[1]);
      args[1] = text;
      if (text === "" || isSupportedLegacySetterValue(legacyProperty, text, args[2])) {
        args[0] = privateAppRegionProperty;
      }
    }
    return original.apply(this, args);
  });
  patchMethod(styleProto, "getPropertyValue", original => function(this: unknown, name: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = mappedPropertyName(name);
    return original.apply(this, args);
  });
  patchMethod(styleProto, "getPropertyPriority", original => function(this: unknown, name: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = mappedPropertyName(name);
    return original.apply(this, args);
  });
  patchMethod(styleProto, "removeProperty", original => function(this: unknown, name: unknown) {
    const args = Array.prototype.slice.call(arguments) as unknown[];
    if (args.length < 1) return original.apply(this, args);
    args[0] = mappedPropertyName(name);
    return original.apply(this, args);
  });
  patchCssText(styleProto);
  patchCamelCaseAlias(styleProto, "webkitAppRegion");
  patchCamelCaseAlias(styleProto, "appRegion");

  try {
    self.on("closed", onSelfClosed);
    target.addEventListener("pagehide", dispose);
    target.addEventListener("atools-plugin-out", dispose);
  } catch (error) { report(error); dispose(); }
  if (isDestroyed()) dispose();
  return { dispose };
}
