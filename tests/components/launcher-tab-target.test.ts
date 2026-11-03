import { describe, expect, it, vi } from "vitest";
import { launcherTabIntent, resolveLauncherTabTarget, tabTargetFromFeature } from "../../src/lib/launcherTabTarget";
import { createLauncherTabTargetController } from "../../src/lib/launcherTabTargetController";
import { normalizeSettings, normalizeLauncherTabTarget, loadAToolsSettingsSync, SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import type { SearchResult } from "../../src/lib/types";
const feature: SearchResult = { code: "convert", plugin_id: "converter", label: "当前名称", plugin_name: "转换工具", explain: "", icon: null, score: 1, match_type: "catalog" };
const target = { ...tabTargetFromFeature(feature), label: "旧名称" };
describe("Tab target identity and input contract", () => {
  it("requires exact owner/code and never resolves a display snapshot", () => {
    expect(resolveLauncherTabTarget(target, [feature])).toEqual({ status: "ready", feature });
    expect(resolveLauncherTabTarget(target, [{ ...feature, plugin_id: "replacement", label: "旧名称" }]).status).toBe("unavailable");
    expect(resolveLauncherTabTarget(target, []).status).toBe("unavailable");
    expect(resolveLauncherTabTarget(null, [feature]).status).toBe("unconfigured");
    expect(resolveLauncherTabTarget(target, [feature, { ...feature, plugin_id: "collision" }]).status).toBe("ambiguous");
    expect(resolveLauncherTabTarget(target, [feature, feature]).status).toBe("ambiguous");
  });
  it.each(["  原文 😀 café  ", "\t全角　a\n末尾\r\n", "", "   "])("preserves exact payload %j", payload => {
    expect(launcherTabIntent(target, [feature], payload)).toMatchObject({ status: "ready", payload, code: "convert", expectedPluginId: "converter" });
  });
  it("normalizes legacy absence and malformed identities, persists stable identity across reload", () => {
    expect(normalizeSettings({}).tabTarget).toBeNull();
    for (const raw of [{ pluginId: " converter", code: "convert" }, { pluginId: "converter", code: "" }, { pluginId: "converter", code: "a\n" }, { label: "current" }]) expect(normalizeLauncherTabTarget(raw)).toBeNull();
    const settings = normalizeSettings({ tabTarget: target });
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    expect(loadAToolsSettingsSync().tabTarget).toEqual(target);
    localStorage.clear();
  });
});
describe("bounded Tab activation", () => {
  it("coalesces repeated Tab while refreshing and uses the captured unmodified text once", async () => {
    let release!: (value: boolean) => void;
    const refresh = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const activate = vi.fn(async () => {}), feedback = vi.fn();
    const controller = createLauncherTabTargetController({ current: () => ({ target, query: " exact ", inScope: true }), refresh, activate, feedback, catalog: () => [feature] });
    const first = controller.launch(); await controller.launch(); expect(refresh).toHaveBeenCalledTimes(1);
    release(true); await first; expect(activate).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledWith("convert", " exact ", "converter", expect.any(Function));
  });
  it.each(["input", "target", "scope", "cancel", "refresh-error"])("does not dispatch stale or unverified work after %s changes", async kind => {
    let release!: (value: boolean) => void;
    let current = { target, query: " exact ", inScope: true };
    const activate = vi.fn(async () => {}), feedback = vi.fn();
    const controller = createLauncherTabTargetController({ current: () => current, refresh: () => new Promise<boolean>(resolve => { release = resolve; }), activate, feedback, catalog: () => [feature] });
    const run = controller.launch();
    if (kind === "input") current = { ...current, query: "new" };
    if (kind === "target") current = { ...current, target: { ...target, pluginId: "other" } };
    if (kind === "scope") current = { ...current, inScope: false };
    if (kind === "cancel") controller.cancel();
    release(kind !== "refresh-error"); await run; expect(activate).not.toHaveBeenCalled();
    if (kind === "refresh-error") expect(feedback).toHaveBeenLastCalledWith(expect.stringContaining("无法刷新"));
  });
});

it("cancelling activation unlocks a new generation without stale feedback or finally clearing its pending state", async () => {
  let current = { target, query: "old", inScope: true };
  const gates: Array<{ reject: (reason: Error) => void; done: () => void; cancelled: () => boolean }> = [];
  const feedback = vi.fn();
  const activate = vi.fn((_code, _payload, _owner, cancelled: () => boolean) => new Promise<void>((done, reject) => { gates.push({ done, reject, cancelled }); }));
  const controller = createLauncherTabTargetController({ current: () => current, refresh: async () => true, catalog: () => [feature], activate, feedback });
  const old = controller.launch(); await Promise.resolve();
  expect(gates).toHaveLength(1);
  controller.cancel(); current = { ...current, query: "new" };
  const newer = controller.launch(); await Promise.resolve(); expect(gates).toHaveLength(2);
  expect(gates[0].cancelled()).toBe(true); expect(gates[1].cancelled()).toBe(false);
  gates[0].reject(Error("late old rejection")); await old;
  expect(feedback).not.toHaveBeenLastCalledWith(expect.stringContaining("未能打开"));
  await controller.launch(); expect(gates).toHaveLength(2);
  gates[1].done(); await newer;
});
