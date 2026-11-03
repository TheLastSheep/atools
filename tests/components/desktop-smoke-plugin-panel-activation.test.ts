import { describe, expect, it, vi } from "vitest";
import { resolveDesktopSmokePluginPanelActivation } from "../../src/lib/desktopSmokePluginPanelActivation";
import type { FeatureAction } from "../../src/lib/types";

const fixture = { headFileTreeAcceptance: true, treePath: "/private/tmp/owned/tree-data" };
const action: FeatureAction = {
  plugin_id: "file-tree", plugin_name: "FileTree", feature_code: "file-tree", main_url: "index.html",
  plugin_path: "/private/tmp/file-tree", expand_height: 400, payload: null,
};

describe("desktop smoke panel activation adapter", () => {
  it("maps only the exact FileTree fixture response into a files activation", async () => {
    const loadFileTreeFixture = vi.fn(async () => fixture);
    const loadCatalogActions = vi.fn(async () => [action]);
    await expect(resolveDesktopSmokePluginPanelActivation({
      fileTreeHeadAcceptance: true, loadFileTreeFixture, loadCatalogActions,
    })).resolves.toEqual({
      kind: "file-tree-head", code: "file-tree", payload: null,
      options: { expectedPluginId: "file-tree", mediaContent: { kind: "files", paths: [fixture.treePath] } },
    });
    expect(loadFileTreeFixture).toHaveBeenCalledTimes(1);
    expect(loadCatalogActions).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { headFileTreeAcceptance: false, treePath: fixture.treePath },
    { headFileTreeAcceptance: true, treePath: "relative/tree" },
    { headFileTreeAcceptance: true, treePath: "/private/tmp/tree\u0000suffix" },
  ])("rejects an invalid FileTree fixture response", async value => {
    await expect(resolveDesktopSmokePluginPanelActivation({
      fileTreeHeadAcceptance: true,
      loadFileTreeFixture: async () => value,
      loadCatalogActions: async () => [action],
    })).rejects.toThrow("Pinned FileTree activation fixture is unavailable");
  });

  it("preserves default catalog action selection and does not load the FileTree fixture", async () => {
    const actions = [action];
    const loadFileTreeFixture = vi.fn(async () => fixture);
    const result = await resolveDesktopSmokePluginPanelActivation({
      fileTreeHeadAcceptance: false,
      loadFileTreeFixture,
      loadCatalogActions: async () => actions,
    });
    expect(result).toEqual({ kind: "catalog-actions", actions });
    expect(loadFileTreeFixture).not.toHaveBeenCalled();
  });

  it("keeps an empty default panel smoke result as a no-op", async () => {
    await expect(resolveDesktopSmokePluginPanelActivation({
      fileTreeHeadAcceptance: false,
      loadFileTreeFixture: async () => fixture,
      loadCatalogActions: async () => [],
    })).resolves.toEqual({ kind: "none" });
  });
});
