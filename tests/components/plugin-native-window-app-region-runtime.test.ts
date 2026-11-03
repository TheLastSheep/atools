import { JSDOM } from "jsdom";
import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createPluginNativeAppRegionCss } from "../../src/lib/pluginNativeAppRegionCss";
import { createPluginNativeAppRegionCssRuntime } from "../../src/lib/pluginNativeAppRegionCssRuntime";
import { createPluginNativeWindowDragRegions } from "../../src/lib/pluginNativeWindowDragRegions";
import { compileNativeWindowSelf } from "./compiledPluginNativeWindowFrameFixture";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";

type NativeListener = (...args: unknown[]) => void;

function makeSelf() {
  const listeners = new Map<string, Set<NativeListener>>();
  let destroyed = false;
  return {
    self: {
      isDestroyed: () => destroyed,
      on(name: string, listener: NativeListener) {
        const set = listeners.get(name) ?? new Set<NativeListener>();
        set.add(listener);
        listeners.set(name, set);
      },
      off(name: string, listener: NativeListener) { listeners.get(name)?.delete(listener); },
    },
    close() {
      destroyed = true;
      for (const listener of [...(listeners.get("closed") ?? [])]) listener();
    },
  };
}

function pointerDown(dom: JSDOM, target: Element, values: Partial<PointerEvent> = {}) {
  const event = new dom.window.Event("pointerdown", { bubbles: true, composed: true, cancelable: true });
  for (const [key, value] of Object.entries({
    pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, ctrlKey: false, ...values,
  })) Object.defineProperty(event, key, { configurable: true, value });
  target.dispatchEvent(event);
  return event;
}

class TestCssStyleSheet {
  readonly rules: string[] = [];
  replacement = "";
  synchronousReplacement = "";
  insertRule(rule: string, index = 0) {
    if (arguments.length < 1) throw new TypeError("insertRule requires a rule");
    this.rules.splice(index, 0, rule);
    return index;
  }
  replace(cssText: string) {
    if (arguments.length < 1) throw new TypeError("replace requires CSS text");
    this.replacement = cssText;
    return Promise.resolve(this);
  }
  replaceSync(cssText: string) {
    if (arguments.length < 1) throw new TypeError("replaceSync requires CSS text");
    this.synchronousReplacement = cssText;
  }
}

class TestCssStyleDeclaration {
  private readonly values = new Map<string, { value: string; priority: string }>();
  setProperty(name: string, value: string, priority = "") {
    if (arguments.length < 2) throw new TypeError("setProperty requires a value");
    this.values.set(name, { value, priority });
  }
  getPropertyValue(name: string) {
    if (arguments.length < 1) throw new TypeError("getPropertyValue requires a name");
    return this.values.get(name)?.value ?? "";
  }
  getPropertyPriority(name: string) {
    if (arguments.length < 1) throw new TypeError("getPropertyPriority requires a name");
    return this.values.get(name)?.priority ?? "";
  }
  removeProperty(name: string) {
    if (arguments.length < 1) throw new TypeError("removeProperty requires a name");
    const value = this.getPropertyValue(name);
    this.values.delete(name);
    return value;
  }
  get cssText() {
    return [...this.values].map(([name, record]) => `${name}: ${record.value}${record.priority ? " !important" : ""};`).join(" ");
  }
  set cssText(value: string) {
    this.values.clear();
    for (const declaration of String(value).split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim();
      const rawValue = declaration.slice(colon + 1).trim();
      const important = /\s*!important$/i.test(rawValue);
      this.setProperty(name, important ? rawValue.replace(/\s*!important$/i, "") : rawValue, important ? "important" : "");
    }
  }
}

describe("native BrowserWindow app-region runtime", () => {
  it("requires a trusted primary left mouse down and honors the nearest computed drag/no-drag region", () => {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="drag" style="--atools-native-app-region: drag">drag button</button>
      <div id="outer" style="--atools-native-app-region: drag"><span id="no-drag" style="--atools-native-app-region: no-drag">label</span><span id="none" style="--atools-native-app-region: none">none</span></div>
      <div id="ordinary">ordinary</div></body>`);
    const startDrag = vi.fn();
    const { self } = makeSelf();
    const controls = createPluginNativeWindowDragRegions(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, beginDrag: startDrag,
    });
    try {
      pointerDown(dom, dom.window.document.querySelector("#drag")!);
      pointerDown(dom, dom.window.document.querySelector("#no-drag")!);
      pointerDown(dom, dom.window.document.querySelector("#ordinary")!);
      expect(startDrag).not.toHaveBeenCalled();
    } finally {
      controls.dispose();
      dom.window.close();
    }
  });

  it("uses the same listener through the explicit trust seam and sends one synchronous epoch for eligible downs", () => {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="drag" style="--atools-native-app-region: drag">drag button</button>
      <div id="outer" style="--atools-native-app-region: drag"><span id="no-drag" style="--atools-native-app-region: no-drag">label</span><span id="none" style="--atools-native-app-region: none">none</span></div>
      <div id="ordinary">ordinary</div></body>`);
    const startDrag = vi.fn();
    const { self } = makeSelf();
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const controls = createPluginNativeWindowDragRegions(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, beginDrag: startDrag,
      isTrustedPointerDown: () => true,
    });
    const button = dom.window.document.querySelector("#drag")!;
    try {
      pointerDown(dom, button);
      pointerDown(dom, button, { button: 2, buttons: 2 });
      pointerDown(dom, button, { ctrlKey: true });
      pointerDown(dom, button, { pointerType: "touch" });
      pointerDown(dom, button, { isPrimary: false });
      pointerDown(dom, button, { buttons: 3 });
      pointerDown(dom, dom.window.document.querySelector("#no-drag")!);
      pointerDown(dom, dom.window.document.querySelector("#none")!);
      pointerDown(dom, dom.window.document.querySelector("#ordinary")!);

      expect(startDrag).toHaveBeenCalledTimes(2);
      expect(startDrag).toHaveBeenCalledWith(123456);
      expect([...dom.window.document.querySelectorAll("*")].some(element => element.localName === "marquee")).toBe(false);
      expect(dom.window.document.querySelector("#drag")!.isConnected).toBe(true);
    } finally {
      controls.dispose();
      now.mockRestore();
      dom.window.close();
    }
  });

  it("disposes gesture handling on pagehide, plugin-out, or native close without adding move listeners", () => {
    const dom = new JSDOM(`<button id="drag" style="--atools-native-app-region:drag"></button>`);
    const { self, close } = makeSelf();
    const startDrag = vi.fn();
    const addEventListener = vi.spyOn(dom.window, "addEventListener");
    const controls = createPluginNativeWindowDragRegions(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, beginDrag: startDrag,
      isTrustedPointerDown: () => true,
    });
    try {
      expect(addEventListener.mock.calls.map(([name]) => name)).not.toContain("pointermove");
      pointerDown(dom, dom.window.document.querySelector("#drag")!);
      dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      pointerDown(dom, dom.window.document.querySelector("#drag")!);
      expect(startDrag).toHaveBeenCalledTimes(1);
      close();
      pointerDown(dom, dom.window.document.querySelector("#drag")!);
      expect(startDrag).toHaveBeenCalledTimes(1);
    } finally {
      controls.dispose();
      dom.window.close();
    }
  });

  it("captures the event epoch before computed style or the test trust callback can re-enter", () => {
    const dom = new JSDOM(`<button id="drag" style="--atools-native-app-region:drag"></button>`);
    const { self } = makeSelf();
    let epoch = 123;
    const now = vi.spyOn(Date, "now").mockImplementation(() => epoch);
    const startDrag = vi.fn();
    const originalGetComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    const controls = createPluginNativeWindowDragRegions(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, beginDrag: startDrag,
      isTrustedPointerDown: () => { epoch = 456; return true; },
    });
    const getStyle = vi.spyOn(dom.window, "getComputedStyle").mockImplementation(element => {
      epoch = 789;
      return originalGetComputedStyle(element);
    });
    try {
      pointerDown(dom, dom.window.document.querySelector("#drag")!);
      expect(startDrag).toHaveBeenCalledWith(123);
      expect(getStyle).toHaveBeenCalled();
    } finally {
      controls.dispose();
      getStyle.mockRestore();
      now.mockRestore();
      dom.window.close();
    }
  });

  it("keeps at most one native drag request in flight and permits another after completion", async () => {
    const dom = new JSDOM(`<button id="drag" style="--atools-native-app-region:drag"></button>`);
    const { self } = makeSelf();
    let resolveFirst!: () => void;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const startDrag = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(undefined);
    const controls = createPluginNativeWindowDragRegions(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, beginDrag: startDrag,
      isTrustedPointerDown: () => true,
    });
    const button = dom.window.document.querySelector("#drag")!;
    try {
      pointerDown(dom, button);
      pointerDown(dom, button);
      expect(startDrag).toHaveBeenCalledTimes(1);
      resolveFirst();
      await first;
      await Promise.resolve();
      pointerDown(dom, button);
      expect(startDrag).toHaveBeenCalledTimes(2);
    } finally {
      controls.dispose();
      dom.window.close();
    }
  });

  it("maps CSSOM rules, declarations, removals, getters, and camelCase properties synchronously", async () => {
    const dom = new JSDOM("<!doctype html><style></style><div id='target'></div>");
    const { self } = makeSelf();
    const mapper = createPluginNativeAppRegionCss();
    const sheetProto = dom.window.CSSStyleSheet.prototype;
    const styleProto = dom.window.CSSStyleDeclaration.prototype;
    const originalInsertRule = sheetProto.insertRule;
    const originalSetProperty = styleProto.setProperty;
    const controls = createPluginNativeAppRegionCssRuntime(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, rewrite: mapper,
    });
    const element = dom.window.document.querySelector("#target")!;
    try {
      element.style.setProperty("-webkit-app-region", "drag", "important");
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("drag");
      expect(element.style.getPropertyValue("app-region")).toBe("drag");
      expect(element.style.getPropertyPriority("-webkit-app-region")).toBe("important");
      expect(element.style.removeProperty("app-region")).toBe("drag");
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("");
      element.style.setProperty("webkitAppRegion", "drag");
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("");

      element.style.cssText = "display: block; app-region: no-drag !important;";
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("no-drag");
      expect(element.style.getPropertyPriority("-webkit-app-region")).toBe("important");
      (element.style as CSSStyleDeclaration & { webkitAppRegion: string }).webkitAppRegion = "drag";
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("drag");
      (element.style as CSSStyleDeclaration & { appRegion: string }).appRegion = "no-drag";
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("no-drag");

      const sheet = dom.window.document.querySelector("style")!.sheet!;
      sheet.insertRule(".drag { -webkit-app-region: drag; }");
      expect(sheet.cssRules[0]?.cssText).toContain("--atools-native-app-region: drag");
      controls.dispose();
      expect(sheetProto.insertRule).toBe(originalInsertRule);
      expect(styleProto.setProperty).toBe(originalSetProperty);
      sheet.insertRule(".legacy { -webkit-app-region: drag; }");
      expect(sheet.cssRules[0]?.cssText).toContain("-webkit-app-region: drag");
      element.style.removeProperty("--atools-native-app-region");
      element.style.setProperty("-webkit-app-region", "drag");
      expect(element.style.getPropertyValue("--atools-native-app-region")).toBe("");
    } finally {
      controls.dispose();
      dom.window.close();
    }
  });

  it("rewrites CSSStyleSheet replacement APIs synchronously and preserves native missing-argument errors", async () => {
    const eventListeners = new Map<string, Set<() => void>>();
    const target = {
      CSSStyleSheet: TestCssStyleSheet,
      CSSStyleDeclaration: TestCssStyleDeclaration,
      addEventListener(name: string, listener: () => void) {
        const listeners = eventListeners.get(name) ?? new Set();
        listeners.add(listener);
        eventListeners.set(name, listeners);
      },
      removeEventListener(name: string, listener: () => void) { eventListeners.get(name)?.delete(listener); },
    } as unknown as Window;
    const { self } = makeSelf();
    const rewrite = createPluginNativeAppRegionCss();
    const originalSetProperty = TestCssStyleDeclaration.prototype.setProperty;
    const controls = createPluginNativeAppRegionCssRuntime(target, {
      windowType: "browserWindow", hostKind: "native", self, rewrite,
    });
    const sheet = new TestCssStyleSheet();
    const style = new TestCssStyleDeclaration() as TestCssStyleDeclaration & { appRegion: string };
    try {
      sheet.insertRule(".a { -webkit-app-region: drag; }");
      sheet.replaceSync(".b { app-region: no-drag; }");
      await sheet.replace(".c { -webkit-app-region: drag !important; }");
      expect(sheet.rules[0]).toContain("--atools-native-app-region: drag");
      expect(sheet.synchronousReplacement).toContain("--atools-native-app-region: no-drag");
      expect(sheet.replacement).toContain("--atools-native-app-region: drag !important");

      style.cssText = "app-region: drag !important;";
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("drag");
      expect(style.getPropertyPriority("-webkit-app-region")).toBe("important");
      expect(style.removeProperty("app-region")).toBe("drag");
      style.appRegion = "no-drag";
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("no-drag");

      expect(() => sheet.insertRule.call(sheet)).toThrow(TypeError);
      expect(() => sheet.replace.call(sheet)).toThrow(TypeError);
      expect(() => sheet.replaceSync.call(sheet)).toThrow(TypeError);
      expect(() => style.setProperty.call(style, "app-region")).toThrow(TypeError);
      expect(() => style.getPropertyValue.call(style)).toThrow(TypeError);
      expect(() => style.removeProperty.call(style)).toThrow(TypeError);

      const replacement = vi.fn();
      Object.defineProperty(TestCssStyleDeclaration.prototype, "setProperty", {
        configurable: true, writable: true, value: replacement,
      });
      controls.dispose();
      expect(TestCssStyleDeclaration.prototype.setProperty).toBe(replacement);
    } finally {
      controls.dispose();
      Object.defineProperty(TestCssStyleDeclaration.prototype, "setProperty", {
        configurable: true, writable: true, value: originalSetProperty,
      });
    }
  });

  it("rewrites dynamically-added native style text and style attributes through the existing resource observer", async () => {
    const frame = compileNativeWindowSelf();
    const dom = new JSDOM(frame.sourceHtml, { url: "https://atools.local/native-window.html", runScripts: "outside-only",
      beforeParse(window) {
        Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
        const mediaPrototype = (window as unknown as { CSSMediaRule?: { prototype: object } }).CSSMediaRule?.prototype;
        const groupingPrototype = mediaPrototype && Object.getPrototypeOf(Object.getPrototypeOf(mediaPrototype));
        if (groupingPrototype) Object.defineProperty(window, "CSSGroupingRule", {
          configurable: true, value: { prototype: groupingPrototype },
        });
        Object.defineProperty(window, "__ATOOLS_FRAME_TRANSPORT__", { configurable: true, value: {
          accept: () => true, post: () => true, ready: () => true, dispose: () => undefined,
        } });
      } });
    try {
      executeCompiledPluginBridgeScripts(frame.sourceHtml, dom.getInternalVMContext(), 3);
      const style = dom.window.document.createElement("style");
      style.textContent = ".dynamic { -webkit-app-region: drag; }";
      dom.window.document.head.append(style);
      const groupedStyle = dom.window.document.createElement("style");
      groupedStyle.textContent = "@media all {}";
      dom.window.document.head.append(groupedStyle);
      const mediaRule = groupedStyle.sheet?.cssRules[0] as CSSMediaRule & { insertRule(rule: string): number };
      mediaRule.insertRule(".nested { app-region: drag; }");
      const element = dom.window.document.createElement("div");
      element.setAttribute("style", "app-region: no-drag;");
      dom.window.document.body.append(element);
      await new Promise<void>(resolve => dom.window.setTimeout(resolve, 0));

      expect(style.textContent).toContain("--atools-native-app-region: drag");
      expect(mediaRule.cssRules[0]?.cssText).toContain("--atools-native-app-region: drag");
      expect(element.getAttribute("style")).toContain("--atools-native-app-region: no-drag");
    } finally {
      dom.window.dispatchEvent(new dom.window.Event("atools-plugin-out"));
      dom.window.close();
      frame.dispose();
    }
  });

  it("preserves valid legacy setter values when later values are invalid and keeps removal and alias semantics", () => {
    const dom = new JSDOM("<!doctype html><div id='target'></div>");
    const { self } = makeSelf();
    const controls = createPluginNativeAppRegionCssRuntime(dom.window, {
      windowType: "browserWindow", hostKind: "native", self, rewrite: createPluginNativeAppRegionCss(),
    });
    const style = dom.window.document.querySelector("#target")!.style as CSSStyleDeclaration & { appRegion: string };
    try {
      style.setProperty("app-region", "drag");
      style.setProperty("app-region", "banana");
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("drag");
      style.appRegion = "banana";
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("drag");

      style.setProperty("-webkit-app-region", null as unknown as string);
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("");
      style.appRegion = "no-drag";
      style.setProperty("app-region", "");
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("");

      style.setProperty("app-region", "drag");
      style.setProperty("--custom-app-region", "banana");
      expect(style.getPropertyValue("--atools-native-app-region")).toBe("drag");
      expect(style.getPropertyValue("--custom-app-region")).toBe("banana");
    } finally {
      controls.dispose();
      dom.window.close();
    }
  });

  it("does nothing for hosted or incomplete fixture realms", () => {
    const { self } = makeSelf();
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Window;
    const hosted = createPluginNativeAppRegionCssRuntime(target, {
      windowType: "browserWindow", hostKind: "hosted", self, rewrite: createPluginNativeAppRegionCss(),
    });
    const incomplete = createPluginNativeAppRegionCssRuntime(target, {
      windowType: "browserWindow", hostKind: "native", self, rewrite: createPluginNativeAppRegionCss(),
    });
    hosted.dispose();
    incomplete.dispose();
    expect(target.addEventListener).not.toHaveBeenCalled();
  });
});
