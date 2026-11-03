import { describe, expect, it } from "vitest";
import { pluginHostView } from "../../src/lib/pluginHostView";
import type { FeatureAction } from "../../src/lib/types";

const action: FeatureAction = {
  plugin_id: "formatter-plugin", plugin_name: "格式工具", feature_code: "format-internal",
  main_url: "index.html", plugin_path: "/synthetic/formatter", expand_height: 541, payload: null,
};
const state = { subInputVisible: false, iframeReady: true, outputItems: [], selectedIndex: 0 };

describe("plugin feature name presentation", () => {
  it.each([undefined, null, "", "  "])("hides missing labels instead of falling back to internal code: %s", feature_label => {
    const view = pluginHostView({ ...action, feature_label }, state);
    expect(view.chrome).toEqual({ title: "格式工具", feature: "" });
    expect(view.diagnostics).toEqual({ featureCode: "format-internal", source: "formatter-plugin" });
  });

  it.each(["declared", "explain", "command_label", "command"] as const)("uses the received readable label from %s without changing execution identity", feature_label_source => {
    const input = { ...action, feature_label: " 格式化 JSON ", feature_label_source };
    const view = pluginHostView(input, state);
    expect(view.chrome.feature).toBe("格式化 JSON");
    expect(view.diagnostics.featureCode).toBe("format-internal");
    expect(input.feature_code).toBe("format-internal");
    expect("source" in view.chrome).toBe(false);
  });

  it("hides a duplicate plugin title and allows distinct names for separate entries", () => {
    expect(pluginHostView({ ...action, feature_label: " 格式工具 " }, state).chrome.feature).toBe("");
    const first = pluginHostView({ ...action, feature_label: "格式化 JSON" }, state);
    const second = pluginHostView({ ...action, feature_code: "compact-internal", feature_label: "压缩 JSON" }, state);
    expect(first.chrome.feature).toBe("格式化 JSON");
    expect(second.chrome.feature).toBe("压缩 JSON");
    expect(second.diagnostics.featureCode).toBe("compact-internal");
  });

  it("preserves an explicitly declared technical name even when it equals the code", () => {
    expect(pluginHostView({ ...action, feature_code: "MD5", feature_label: "MD5", feature_label_source: "declared" }, state).chrome.feature).toBe("MD5");
  });
});
