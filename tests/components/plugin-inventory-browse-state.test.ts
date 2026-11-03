import { describe, expect, it } from "vitest";
import {
  clampPluginInventoryPage,
  createPluginInventoryBrowseState,
  pluginInventoryFilterKey,
} from "../../src/lib/pluginInventoryBrowseState";

describe("installed plugin browse state", () => {
  it("starts clean for each settings session", () => {
    expect(createPluginInventoryBrowseState()).toEqual({ status: "all", source: "all", page: 1 });
    expect(createPluginInventoryBrowseState()).not.toBe(createPluginInventoryBrowseState());
  });

  it("clamps a restored page only when the current result count requires it", () => {
    expect(clampPluginInventoryPage(2, 4)).toBe(2);
    expect(clampPluginInventoryPage(4, 2)).toBe(2);
    expect(clampPluginInventoryPage(0, 2)).toBe(1);
    expect(clampPluginInventoryPage(3, 0)).toBe(1);
  });

  it("tracks query, status, and source as one filter identity", () => {
    const current = pluginInventoryFilterKey("tool-", "disabled", "imported");
    expect(pluginInventoryFilterKey("tool-", "disabled", "imported")).toBe(current);
    expect(pluginInventoryFilterKey("tool-", "all", "imported")).not.toBe(current);
    expect(pluginInventoryFilterKey("tool-", "disabled", "all")).not.toBe(current);
    expect(pluginInventoryFilterKey("other", "disabled", "imported")).not.toBe(current);
  });
});
