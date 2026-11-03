import { afterEach, describe, expect, it } from "vitest";
import { launcherActionCode, resolveLauncherAction } from "../../src/lib/launcherCommandActions";
import { LAUNCHER_PIN_SNAPSHOTS_KEY, loadLauncherPinSnapshots, persistLauncherPins, pinnedLauncherCommands, reconcileLauncherPins } from "../../src/lib/launcherPins";
import type { SearchResult } from "../../src/lib/types";

const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换插件", label: "字符转换", explain: "转换文本", icon: null, score: 100, match_type: "exact" };
const context = () => ({ codes: [feature.code], catalog: [feature], snapshots: [], catalogReady: true, resolveLocal: () => null });
afterEach(() => localStorage.clear());

describe("launcher pin identity and cold-start metadata", () => {
  it("restores a bounded display snapshot before the existing catalog request settles", () => {
    const prepared = reconcileLauncherPins(context());
    persistLauncherPins(prepared);
    const snapshots = loadLauncherPinSnapshots();
    expect(Object.keys(snapshots[0]).sort()).toEqual(["code", "explain", "icon", "label", "plugin_id", "plugin_name"]);
    const cold = { ...context(), catalog: [], snapshots, catalogReady: false };
    expect(pinnedLauncherCommands(cold)).toEqual([{ code: "convert", label: "字符转换", explain: "转换文本", plugin_id: "converter", icon: null, panel: undefined }]);
    expect(reconcileLauncherPins(cold)).toEqual(prepared);
  });

  it("invalidates known removal and never rebinds a cached code to a different plugin", () => {
    const prepared = reconcileLauncherPins(context());
    for (const catalog of [[], [{ ...feature, plugin_id: "different-owner" }]]) {
      const reconciled = reconcileLauncherPins({ ...context(), ...prepared, catalog });
      expect(reconciled).toEqual({ codes: [], snapshots: [] });
      persistLauncherPins(reconciled);
      expect(loadLauncherPinSnapshots()).toEqual([]);
    }
  });

  it("refreshes display metadata from the same owner and removes unpinned snapshots", () => {
    const prepared = reconcileLauncherPins(context());
    const refreshed = reconcileLauncherPins({ ...context(), ...prepared, catalog: [{ ...feature, label: "新的名称" }] });
    expect(refreshed.snapshots[0].label).toBe("新的名称");
    expect(reconcileLauncherPins({ ...context(), ...prepared, codes: [] })).toEqual({ codes: [], snapshots: [] });
  });

  it("rejects malformed/oversized storage and caps snapshots without retaining execution fields", () => {
    localStorage.setItem(LAUNCHER_PIN_SNAPSHOTS_KEY, JSON.stringify([{ ...feature, plugin_id: 42 }]));
    expect(loadLauncherPinSnapshots()).toEqual([]);
    localStorage.setItem(LAUNCHER_PIN_SNAPSHOTS_KEY, " ".repeat(256 * 1024 + 1));
    expect(loadLauncherPinSnapshots()).toEqual([]);
    localStorage.setItem(LAUNCHER_PIN_SNAPSHOTS_KEY, JSON.stringify(Array.from({ length: 160 }, () => ({ ...feature, main_url: "must-not-persist" }))));
    expect(loadLauncherPinSnapshots()).toHaveLength(128);
    expect(loadLauncherPinSnapshots()[0]).not.toHaveProperty("main_url");
  });
});

describe("stable launcher menu targets", () => {
  it("normalizes history, aliases and system recommendations without pinning transient text payloads", () => {
    const history = "history:" + encodeURIComponent(JSON.stringify({ code: "convert", input: "私人输入" }));
    expect(launcherActionCode({ code: history, label: "旧名称" })).toBe("convert");
    expect(launcherActionCode({ code: "设置", label: "设置", panel: "settings" })).toBe("system:settings");
    expect(launcherActionCode({ code: "text:any", label: "复制文本" })).toBeNull();
    expect(launcherActionCode({ code: "history:broken", label: "损坏记录" })).toBeNull();
    expect(resolveLauncherAction({ code: history, label: "旧名称", plugin_id: "command-history" }, context())?.plugin_id).toBe("converter");
    expect(JSON.stringify(reconcileLauncherPins(context()))).not.toContain("私人输入");
  });

  it("rejects source identity changes and unavailable commands rather than fabricating a target", () => {
    expect(resolveLauncherAction({ ...feature, plugin_id: "different-owner" }, context())).toBeNull();
    expect(resolveLauncherAction({ code: "missing", label: "丢失插件" }, context())).toBeNull();
    expect(resolveLauncherAction(feature, context())?.code).toBe("convert");
  });
});
