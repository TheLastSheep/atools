import { describe, expect, it, vi } from "vitest";
import { observeRequiredFixtureForeground } from "./nativePublishedForegroundPrecondition";

const nativeReady = {
  mode: "foreground", nativeVisible: true, nativeFocused: true, appActive: true,
  appHidden: false, frontmostIsSelf: true, windowOcclusionVisible: true,
};
const rendererReady = { visibilityState: "visible", documentHasFocus: true };
const boundedWait = async <T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const value = await read();
    if (value != null) return value as NonNullable<T>;
  }
  throw Error(label);
};
const evidence = {
  native: { nativeVisible: true, nativeFocused: true, appActive: true, appHidden: false,
    frontmostIsSelf: true, windowOcclusionVisible: true },
  renderer: { visibilityState: "visible", documentHasFocus: true },
};

describe("opt-in native fixture foreground precondition", () => {
  it("leaves the default observation path without ensure, observe, renderer, or wait work", async () => {
    const ensure = vi.fn(async () => nativeReady), observeNative = vi.fn(async () => nativeReady);
    const readRenderer = vi.fn(() => rendererReady);
    let waitCount = 0;
    const waitFor = async <T>(read: () => T | Promise<T>, label: string) => {
      waitCount++;
      return boundedWait(read, label);
    };
    const result = await observeRequiredFixtureForeground(false, ensure, observeNative, readRenderer, waitFor);
    expect(result).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    expect(observeNative).not.toHaveBeenCalled();
    expect(readRenderer).not.toHaveBeenCalled();
    expect(waitCount).toBe(0);
  });

  it("still ensures once when the optional observation callback is omitted", async () => {
    const ensure = vi.fn(async () => nativeReady), observeNative = vi.fn(async () => nativeReady);
    const readRenderer = vi.fn(() => rendererReady);
    let waitCount = 0;
    const waitFor = async <T>(read: () => T | Promise<T>, label: string) => {
      waitCount++;
      return boundedWait(read, label);
    };
    const result = await observeRequiredFixtureForeground(true, ensure, observeNative, readRenderer, waitFor);
    expect(result).toEqual(evidence);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(observeNative).toHaveBeenCalledTimes(1);
    expect(readRenderer).toHaveBeenCalledTimes(1);
    expect(waitCount).toBe(1);
  });

  it("ensures once then waits for a later same-round native and renderer positive", async () => {
    const ensure = vi.fn(async () => ({ ...nativeReady, nativeVisible: false }));
    const observed = [{ ...nativeReady, nativeVisible: false }, nativeReady];
    const observeNative = vi.fn(async () => observed.shift() ?? nativeReady);
    const readRenderer = vi.fn(() => rendererReady), observations: unknown[] = [];
    const result = await observeRequiredFixtureForeground(true, ensure, observeNative, readRenderer, boundedWait,
      value => observations.push(value));
    expect(result).toEqual(evidence);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(observeNative).toHaveBeenCalledTimes(2);
    expect(observations[0]).toMatchObject({ native: { nativeVisible: false }, renderer: null });
    expect(observations.at(-1)).toEqual({ native: { ...nativeReady }, renderer: rendererReady });
  });

  it("does not combine a prior native positive with renderer focus from a later unfocused round", async () => {
    const ensure = vi.fn(async () => nativeReady);
    const observed = [nativeReady, { ...nativeReady, nativeFocused: false }];
    const observeNative = vi.fn(async () => observed.shift() ?? { ...nativeReady, nativeFocused: false });
    const renderers = [{ visibilityState: "hidden", documentHasFocus: false }, rendererReady];
    const readRenderer = vi.fn(() => renderers.shift() ?? rendererReady), observations: unknown[] = [];
    await expect(observeRequiredFixtureForeground(true, ensure, observeNative, readRenderer, boundedWait,
      value => observations.push(value))).rejects.toThrow(/native and renderer foreground/);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(observeNative).toHaveBeenCalledTimes(4);
    expect(observations.at(-1)).toMatchObject({ native: { nativeFocused: false }, renderer: rendererReady });
  });

  it.each([
    ["nativeVisible", undefined], ["nativeFocused", null], ["appActive", false], ["appHidden", true],
    ["frontmostIsSelf", "yes"], ["windowOcclusionVisible", null], ["mode", "unknown"],
  ])("fails closed for missing or malformed %s evidence", async (key, value) => {
    const invalid: Record<string, unknown> = { ...nativeReady };
    if (value === undefined) delete invalid[key];
    else invalid[key] = value;
    const ensure = vi.fn(async () => nativeReady), observeNative = vi.fn(async () => invalid);
    const readRenderer = vi.fn(() => rendererReady), observations: unknown[] = [];
    await expect(observeRequiredFixtureForeground(true, ensure, observeNative, readRenderer, boundedWait,
      snapshot => observations.push(snapshot))).rejects.toThrow(/native and renderer foreground/);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(observeNative).toHaveBeenCalledTimes(4);
    const expectedValue = key === "mode" ? "unknown" : value === true || value === false ? value : null;
    expect(observations.at(-1)).toMatchObject({ native: { [key]: expectedValue } });
  });

  it("normalizes renderer visibility to a bounded category and rejects hidden, unfocused, or unknown states", async () => {
    for (const renderer of [
      { visibilityState: "hidden", documentHasFocus: true },
      { visibilityState: "visible", documentHasFocus: false },
      { visibilityState: "sensitive-value", documentHasFocus: true },
    ]) {
      const ensure = vi.fn(async () => nativeReady), observeNative = vi.fn(async () => nativeReady);
      const observations: unknown[] = [];
      await expect(observeRequiredFixtureForeground(true, ensure, observeNative, () => renderer, boundedWait,
        value => observations.push(value))).rejects.toThrow(/native and renderer foreground/);
      expect(observations.at(-1)).toMatchObject({ renderer: {
        visibilityState: renderer.visibilityState === "visible" || renderer.visibilityState === "hidden" ? renderer.visibilityState : "other",
        documentHasFocus: renderer.documentHasFocus,
      } });
      expect(JSON.stringify(observations)).not.toContain("sensitive-value");
    }
  });

  it("does not record values beyond bounded native/renderer categories", async () => {
    const observations: unknown[] = [];
    await expect(observeRequiredFixtureForeground(true,
      async () => ({ ...nativeReady, mode: "/private/path" }),
      async () => ({ ...nativeReady, nativeVisible: false, keyboardOwner: "private-value" }),
      () => ({ visibilityState: "private-visibility", documentHasFocus: false }), boundedWait,
      value => observations.push(value))).rejects.toThrow();
    expect(JSON.stringify(observations)).not.toMatch(/private\/path|private-value|private-visibility/);
  });
});
