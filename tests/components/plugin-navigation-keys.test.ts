import { describe, expect, it } from "vitest";
import { pluginNavigationIntent } from "../../src/lib/pluginNavigationKeys";

const key = (value: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: value, cancelable: true, ...init });

describe("plugin input navigation policy", () => {
  it("returns only for an unmodified Backspace on a genuinely empty input", () => {
    expect(pluginNavigationIntent(key("Backspace"), "")).toBe("return");
    expect(pluginNavigationIntent(key("Backspace"), "文字")).toBeNull();
    expect(pluginNavigationIntent(key("Backspace"), " ")).toBeNull();
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
      expect(pluginNavigationIntent(key("Backspace", { [modifier]: true }), "")).toBeNull();
    }
  });

  it("clears input before asking the host's Escape policy to exit", () => {
    expect(pluginNavigationIntent(key("Escape"), "筛选")).toBe("clear");
    expect(pluginNavigationIntent(key("Escape"), " ")).toBe("clear");
    expect(pluginNavigationIntent(key("Escape"), "")).toBe("escape");
  });

  it("leaves IME candidates and previously handled keys untouched", () => {
    for (const name of ["Backspace", "Escape", "ArrowUp", "ArrowDown", "Enter"]) {
      expect(pluginNavigationIntent(key(name, { isComposing: true }), "")).toBeNull();
      expect(pluginNavigationIntent(key(name), "", true)).toBeNull();
      const webkit = key(name);
      Object.defineProperty(webkit, "keyCode", { value: 229 });
      expect(pluginNavigationIntent(webkit, "")).toBeNull();
      const handled = key(name); handled.preventDefault();
      expect(pluginNavigationIntent(handled, "")).toBeNull();
    }
  });

  it("offers output navigation without taking caret, selection or native shortcuts", () => {
    expect(pluginNavigationIntent(key("ArrowUp"), "值")).toBe("previous");
    expect(pluginNavigationIntent(key("ArrowDown"), "值")).toBe("next");
    expect(pluginNavigationIntent(key("Enter"), "值")).toBe("activate");
    for (const name of ["ArrowLeft", "ArrowRight", "Tab", "a"]) expect(pluginNavigationIntent(key(name), "值")).toBeNull();
    expect(pluginNavigationIntent(key("ArrowUp", { shiftKey: true }), "值")).toBeNull();
    expect(pluginNavigationIntent(key("Enter", { metaKey: true }), "值")).toBeNull();
  });
});
