import { describe, expect, it } from "vitest";
import { pluginInventory } from "../../src/lib/pluginInventory";
import type { InstalledPlugin } from "../../src/lib/types";
import { resolvePluginInventoryOpenIntent, samePluginInventoryFeatureTarget } from "../../src/lib/pluginInventoryFeatureSearch";

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const base: InstalledPlugin = {
    id: "search-plugin", name: "Search Plugin", version: "1.2.3", enabled: true,
    source_kind: "imported", path: "/fixture/search-plugin", created_at: "2026-10-01", updated_at: "2026-10-02",
    manifest: { title: "Feature Toolbox", description: "metadata phrase", features: [
      { code: "first", label: "Default action", explain: "First explanation" },
      { code: "second-feature", label: "Later action", explain: "Exact later explanation" },
      { code: "third", label: "Shared label", explain: "Shared explanation" },
    ] },
  };
  return { ...base, ...overrides, manifest: { ...base.manifest, ...overrides.manifest } };
}

describe("installed-plugin feature query targets", () => {
  it.each([
    ["second-feature", "second-feature"],
    ["Later action", "second-feature"],
    ["Exact later explanation", "second-feature"],
  ])("maps a unique feature %s hit to its original code", (query, code) => {
    const result = pluginInventory([plugin()], { query });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].queryFeatureTarget).toEqual({ code, label: "Later action" });
  });

  it.each(["", "search-plugin", "Search Plugin", "Feature Toolbox", "1.2.3", "metadata phrase", "/fixture/search-plugin", "导入"])(
    "keeps %s on the generic path",
    query => expect(pluginInventory([plugin()], { query }).rows[0].queryFeatureTarget).toBeNull(),
  );

  it("gives metadata precedence even when the query also occurs in a feature", () => {
    const candidate = plugin({ manifest: { title: "Later action", features: [
      { code: "second-feature", label: "Later action", explain: "Exact later explanation" },
    ] } });
    expect(pluginInventory([candidate], { query: "Later action" }).rows[0].queryFeatureTarget).toBeNull();
  });

  it("keeps ambiguous and unaddressable feature hits visible without guessing a target", () => {
    const ambiguous = plugin({ manifest: { features: [
      { code: "alpha", label: "Shared search", explain: "" },
      { code: "beta", label: "Shared search two", explain: "" },
    ] } });
    expect(pluginInventory([ambiguous], { query: "Shared search" }).rows[0].queryFeatureTarget).toBeNull();

    for (const code of ["", "   "]) {
      const invalid = plugin({ manifest: { features: [{ code, label: "Unique keyword", explain: "" }] } });
      expect(pluginInventory([invalid], { query: "Unique keyword" }).rows[0].queryFeatureTarget).toBeNull();
    }
    const duplicate = plugin({ manifest: { features: [
      { code: "same-code", label: "Unique keyword", explain: "" },
      { code: "same-code", label: "Different label", explain: "no match" },
    ] } });
    expect(pluginInventory([duplicate], { query: "Unique keyword" }).rows[0].queryFeatureTarget).toBeNull();
  });

  it("rejects a rendered target if a fresh derive changes or removes its intent", () => {
    const old = pluginInventory([plugin()], { query: "second-feature" }).rows[0].queryFeatureTarget;
    const missing = pluginInventory([plugin({ manifest: { features: [
      { code: "first", label: "Default action", explain: "First explanation" },
    ] } })], { query: "second-feature" }).rows[0]?.queryFeatureTarget ?? null;
    const ambiguous = pluginInventory([plugin({ manifest: { features: [
      { code: "second-feature", label: "second-feature one", explain: "" },
      { code: "other", label: "second-feature two", explain: "" },
    ] } })], { query: "second-feature" }).rows[0].queryFeatureTarget;

    expect(samePluginInventoryFeatureTarget(old, missing)).toBe(false);
    expect(samePluginInventoryFeatureTarget(old, ambiguous)).toBe(false);
    expect(samePluginInventoryFeatureTarget(null, null)).toBe(true);
    expect(resolvePluginInventoryOpenIntent(old, ambiguous, true)).toBeNull();
    expect(resolvePluginInventoryOpenIntent(null, null, true)).toEqual({});
    expect(resolvePluginInventoryOpenIntent(old, old, false)).toBeNull();
  });

  it("preserves feature preview and search-text projection", () => {
    const result = pluginInventory([plugin()]);
    expect(result.rows[0].featurePreview).toBe("Default action / Later action / Shared label");
    expect(result.rows[0].searchText).toBe("Search Plugin first Default action First explanation second-feature Later action Exact later explanation third Shared label Shared explanation");
    expect(result.rows[0].hasMoreFeatures).toBe(false);
  });
});
