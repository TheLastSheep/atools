import type { FeatureAction } from "./types";

type FileTreeHeadFixture = {
  headFileTreeAcceptance: true;
  treePath: string;
};

export type DesktopSmokePluginPanelActivation =
  | {
      kind: "file-tree-head";
      code: "file-tree";
      payload: null;
      options: {
        expectedPluginId: "file-tree";
        mediaContent: { kind: "files"; paths: [string] };
      };
    }
  | { kind: "catalog-actions"; actions: FeatureAction[] }
  | { kind: "none" };

export type DesktopSmokePluginPanelActivationLoaders = {
  fileTreeHeadAcceptance: boolean;
  loadFileTreeFixture: () => Promise<unknown>;
  loadCatalogActions: () => Promise<unknown>;
};

/** Selects the smoke source and converts its native fixture response into the App activation request. */
export async function resolveDesktopSmokePluginPanelActivation({
  fileTreeHeadAcceptance,
  loadFileTreeFixture,
  loadCatalogActions,
}: DesktopSmokePluginPanelActivationLoaders): Promise<DesktopSmokePluginPanelActivation> {
  if (fileTreeHeadAcceptance) {
    const fixture = validateFileTreeHeadFixture(await loadFileTreeFixture());
    return {
      kind: "file-tree-head",
      code: "file-tree",
      payload: null,
      options: {
        expectedPluginId: "file-tree",
        mediaContent: { kind: "files", paths: [fixture.treePath] },
      },
    };
  }

  const actions = await loadCatalogActions();
  if (!Array.isArray(actions)) throw new Error("Desktop smoke panel actions are invalid");
  if (actions.length === 0) return { kind: "none" };
  return { kind: "catalog-actions", actions: actions as FeatureAction[] };
}

function validateFileTreeHeadFixture(value: unknown): FileTreeHeadFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pinned FileTree activation fixture is unavailable");
  }
  const fixture = value as Record<string, unknown>;
  const treePath = fixture.treePath;
  if (fixture.headFileTreeAcceptance !== true || typeof treePath !== "string" || !treePath.startsWith("/")
    || /[\u0000-\u001f\u007f]/u.test(treePath)) {
    throw new Error("Pinned FileTree activation fixture is unavailable");
  }
  return { headFileTreeAcceptance: true, treePath };
}
