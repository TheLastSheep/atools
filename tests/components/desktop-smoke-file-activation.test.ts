import { describe, expect, it, vi } from "vitest";
import type { FeatureAction } from "../../src/lib/types";
import { createDesktopSmokeOrchestration } from "../../src/lib/desktopSmokeOrchestration";
import { createLauncherDesktopSmokeHost } from "../../src/lib/launcherDesktopSmokeHost";
import { createDesktopSmokeActionStateFixture } from "./desktopSmokeActionStateFixture.svelte";
import {
  activateDesktopSmokeFileAction,
  isDesktopSmokeActionExternalPlan,
} from "../../src/lib/desktopSmokeFileActivation";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

const MARKER = "__atools_desktop_smoke_external_plan";
const PATHS_MARKER = "__atools_desktop_smoke_file_paths";
const FIXTURE_PATH = "/private/tmp/atools-live-markdown/fixture.md";

function action(payload: unknown = null, overrides: Partial<FeatureAction> = {}): FeatureAction {
  return {
    plugin_id: "live-markdown",
    feature_code: "typora-workbench",
    plugin_name: "Live Markdown",
    main_url: "dist/index.html",
    plugin_path: "/tmp/live-markdown",
    expand_height: 820,
    payload,
    ...overrides,
  };
}

function descriptor(paths: unknown = [FIXTURE_PATH], overrides: Partial<FeatureAction> = {}) {
  return action({ trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: paths }, overrides);
}

type SmokeState = {
  activePlugin: FeatureAction | null;
  desktopSmokePluginActions: FeatureAction[];
  desktopSmokePluginIndex: number;
  activePanel: "home" | "plugins" | "settings" | "agent";
  query: string;
  results: [];
  selectedIndex: number;
};

type TestActivationOptions = {
  waitForPluginReady?: boolean;
  readyTimeoutMs?: number;
  expectedPluginId?: string;
  throwOnError?: boolean;
  mediaContent?: { kind: "files"; paths: string[] };
  isCancelled?: () => boolean;
};

function createOrchestration(
  actions: FeatureAction[],
  activateFeature: (code: string, payload?: unknown, options?: TestActivationOptions) => Promise<number | null>,
) {
  const state: SmokeState = {
    activePlugin: null,
    desktopSmokePluginActions: actions,
    desktopSmokePluginIndex: -1,
    activePanel: "plugins",
    query: "smoke query",
    results: [],
    selectedIndex: 3,
  };
  const resizePalette = vi.fn(async (_height: number) => {});
  const orchestration = createDesktopSmokeOrchestration({
    state,
    hasTauriRuntime: () => false,
    desktopPluginPanelSmokeEnabled: () => false,
    waitForTauriRuntime: async () => false,
    sleep: async (_ms: number) => {},
    activateFeature,
    resizePalette,
    returnPluginToSearch: async () => {},
    openSettingsMenu: async () => {},
    onPanelChange: async () => {},
  });
  return { state, orchestration, resizePalette };
}

describe("desktop smoke catalog file activation", () => {
  it("routes external-plan file metadata through owner-checked media activation without adding plugin metadata", async () => {
    const metadataAction = descriptor();
    const realFilesPayload = Object.freeze([
      Object.freeze({ path: FIXTURE_PATH, name: "fixture.md", isDirectory: false }),
    ]);
    const realAction = action(realFilesPayload);
    const activateFeature = vi.fn(async (
      _code: string,
      _payload: null,
      options: {
        expectedPluginId: string;
        mediaContent: { kind: "files"; paths: string[] };
        throwOnError: true;
      },
    ) => {
      return 14;
    });

    await expect(activateDesktopSmokeFileAction(metadataAction, activateFeature)).resolves.toBe(true);

    expect(activateFeature).toHaveBeenCalledOnce();
    expect(activateFeature).toHaveBeenCalledWith("typora-workbench", null, expect.objectContaining({
      expectedPluginId: "live-markdown",
      mediaContent: { kind: "files", paths: [FIXTURE_PATH] },
      throwOnError: true,
    }));
    expect(activateFeature.mock.calls[0]?.[2]).not.toHaveProperty("onCommitted");
    expect(isDesktopSmokeActionExternalPlan(realAction, [metadataAction], 0)).toBe(true);
    expect(realAction.payload).toBe(realFilesPayload);
    expect(realAction.payload).toEqual([{ path: FIXTURE_PATH, name: "fixture.md", isDirectory: false }]);
    expect(Object.keys(realFilesPayload)).toEqual(["0"]);
  });

  it("publishes the controller's real file action, never the catalog activation descriptor", async () => {
    const metadataAction = descriptor();
    const realFilesPayload = [{ path: FIXTURE_PATH, name: "fixture.md", isDirectory: false }];
    const realAction = action(realFilesPayload);
    let state: SmokeState | undefined;
    const activateFeature = vi.fn(async (
      _code: string,
      _payload?: unknown,
      options?: TestActivationOptions,
    ) => {
      if (state) state.activePlugin = realAction;
      return 14;
    });
    const smoke = createOrchestration([metadataAction], activateFeature);
    state = smoke.state;

    await smoke.orchestration.activateDesktopSmokePluginAction(0);

    expect(smoke.state.activePlugin).toBe(realAction);
    expect(smoke.state.activePlugin).not.toBe(metadataAction);
    expect(realAction.payload).toBe(realFilesPayload);
    expect(realAction.payload).toEqual([{ path: FIXTURE_PATH, name: "fixture.md", isDirectory: false }]);
    expect(isDesktopSmokeActionExternalPlan(realAction)).toBe(false);
    expect(smoke.orchestration.desktopSmokeActionExternalPlan(realAction)).toBe(true);
    expect(activateFeature).toHaveBeenCalledWith("typora-workbench", null, expect.objectContaining({
      expectedPluginId: "live-markdown",
      mediaContent: { kind: "files", paths: [FIXTURE_PATH] },
      throwOnError: true,
    }));
    expect(activateFeature.mock.calls[0]?.[2]).not.toHaveProperty("onCommitted");
    expect(smoke.resizePalette).not.toHaveBeenCalled();
  });

  it("rejects a replacement owner through the activation port's owner guard", async () => {
    const metadataAction = descriptor();
    const replacement = action([{ path: FIXTURE_PATH }], { plugin_id: "another-plugin" });
    let published: FeatureAction | null = null;
    const activateFeature = vi.fn(async (
      _code: string,
      _payload: null,
      options: { expectedPluginId: string },
    ) => {
      if (replacement.plugin_id !== options.expectedPluginId) {
        throw new Error("FEATURE_OWNER_CHANGED: activate_feature returned a different owner");
      }
      published = replacement;
      return 14;
    });

    await expect(activateDesktopSmokeFileAction(metadataAction, activateFeature)).rejects.toThrow("FEATURE_OWNER_CHANGED");
    expect(published).toBeNull();
    expect(activateFeature.mock.calls[0]?.[2].expectedPluginId).toBe("live-markdown");
    expect(isDesktopSmokeActionExternalPlan(replacement, [metadataAction], 0)).toBe(false);
  });

  it("leaves ordinary catalog actions for the existing non-file path", async () => {
    const activateFeature = vi.fn();
    await expect(activateDesktopSmokeFileAction(action(null), activateFeature)).resolves.toBe(false);
    expect(activateFeature).not.toHaveBeenCalled();
  });

  it("keeps legacy external text plans on the existing text activation path", async () => {
    const legacyTextPlan = action({ trigger_type: "text", query: "fixture", [MARKER]: true });
    const activateFeature = vi.fn(async () => 1);
    const smoke = createOrchestration([legacyTextPlan], activateFeature);
    await smoke.orchestration.activateDesktopSmokePluginAction(0);
    expect(smoke.state.activePlugin).toBe(legacyTextPlan);
    expect(smoke.resizePalette).toHaveBeenCalledWith(legacyTextPlan.expand_height);
    expect(activateFeature).not.toHaveBeenCalled();
    expect(isDesktopSmokeActionExternalPlan(legacyTextPlan)).toBe(true);
  });

  it("keeps ordinary catalog action publication and palette sizing unchanged", async () => {
    const ordinaryAction = action(null);
    const activateFeature = vi.fn(async () => 1);
    const smoke = createOrchestration([ordinaryAction], activateFeature);
    await smoke.orchestration.activateDesktopSmokePluginAction(0);
    expect(smoke.state.activePlugin).toBe(ordinaryAction);
    expect(smoke.resizePalette).toHaveBeenCalledWith(ordinaryAction.expand_height);
    expect(activateFeature).not.toHaveBeenCalled();
  });

  it("keeps legacy external-plan marker classification", () => {
    expect(isDesktopSmokeActionExternalPlan(action({ __atools_desktop_smoke_external_plan: true }))).toBe(true);
    expect(isDesktopSmokeActionExternalPlan(action(null))).toBe(false);
    expect(isDesktopSmokeActionExternalPlan(descriptor())).toBe(false);
  });

  it("classifies Svelte-proxied active actions from stable queue identity and rejects non-matches", () => {
    const queuedDescriptor = descriptor();
    const rawActiveAction = action([{ path: FIXTURE_PATH }]);
    const runeState = createDesktopSmokeActionStateFixture(rawActiveAction);
    const activeProxy = runeState.activeAction;

    expect(activeProxy).not.toBe(rawActiveAction);
    expect(isDesktopSmokeActionExternalPlan(activeProxy, [queuedDescriptor], 0)).toBe(true);
    expect(isDesktopSmokeActionExternalPlan({ ...rawActiveAction }, [queuedDescriptor], 0)).toBe(true);

    const identityDifferences: Partial<FeatureAction>[] = [
      { plugin_id: "replacement-plugin" },
      { plugin_path: "/tmp/replacement-plugin" },
      { feature_code: "replacement-feature" },
      { main_url: "dist/replacement.html" },
    ];
    for (const difference of identityDifferences) {
      expect(isDesktopSmokeActionExternalPlan(action(rawActiveAction.payload, difference), [queuedDescriptor], 0)).toBe(false);
    }
    expect(isDesktopSmokeActionExternalPlan(activeProxy, [queuedDescriptor], 1)).toBe(false);
    expect(isDesktopSmokeActionExternalPlan(activeProxy)).toBe(false);
  });

  it("uses the same external-plan classification in orchestration and the launcher host", async () => {
    const active = action([{ path: FIXTURE_PATH }]);
    let smokeState: SmokeState | undefined;
    const activateFeature = vi.fn(async () => {
      if (smokeState) smokeState.activePlugin = active;
      return 1;
    });
    const smoke = createOrchestration([descriptor()], activateFeature);
    smokeState = smoke.state;
    await smoke.orchestration.activateDesktopSmokePluginAction(0);
    const host = createLauncherDesktopSmokeHost({
      state: smoke.state,
      hasTauriRuntime: () => false,
      waitForTauriRuntime: async () => false,
      sleep: async (_ms: number) => {},
      activateFeature,
      resizePalette: async (_height: number) => {},
      returnPluginToSearch: async () => {},
      openSettingsMenu: async () => {},
      onPanelChange: async () => {},
    });
    expect(host.desktopSmokeActionExternalPlan).not.toBe(smoke.orchestration.desktopSmokeActionExternalPlan);
    expect(host.desktopSmokeActionExternalPlan(active)).toBe(true);
    expect(smoke.orchestration.desktopSmokeActionExternalPlan(active)).toBe(true);
    host.dispose();
  });

  it.each([
    { label: "files trigger without file paths", payload: { trigger_type: "files", [MARKER]: true } },
    { label: "non-array file paths", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: FIXTURE_PATH } },
    { label: "empty file paths", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: [] } },
    { label: "too many files", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: Array.from({ length: 21 }, (_, index) => `/tmp/${index}.md`) } },
    { label: "relative path", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: ["relative/fixture.md"] } },
    { label: "control character", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: ["/tmp/fixture\n.md"] } },
    { label: "C1 control character", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: ["/tmp/fixture\u0085.md"] } },
    { label: "oversized UTF-8 path", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: [`/${"文".repeat(2731)}`] } },
    { label: "duplicate path", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: [FIXTURE_PATH, FIXTURE_PATH] } },
    { label: "missing external marker", payload: { trigger_type: "files", [PATHS_MARKER]: [FIXTURE_PATH] } },
    { label: "malformed external marker", payload: { trigger_type: "files", [MARKER]: "true", [PATHS_MARKER]: [FIXTURE_PATH] } },
    { label: "wrong trigger type", payload: { trigger_type: "text", [MARKER]: true, [PATHS_MARKER]: [FIXTURE_PATH] } },
    { label: "missing plugin owner", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: [FIXTURE_PATH] }, overrides: { plugin_id: "" } },
    { label: "missing feature code", payload: { trigger_type: "files", [MARKER]: true, [PATHS_MARKER]: [FIXTURE_PATH] }, overrides: { feature_code: "" } },
  ] satisfies Array<{ label: string; payload: unknown; overrides?: Partial<FeatureAction> }>)
    ("throws for $label rather than publishing descriptor payload", async ({ payload, overrides }) => {
    const activateFeature = vi.fn();
    await expect(activateDesktopSmokeFileAction(action(payload, overrides), activateFeature)).rejects.toThrow();
    expect(activateFeature).not.toHaveBeenCalled();
  });

  it("accepts bounded absolute POSIX and Windows paths without rewriting them", async () => {
    const paths = ["/tmp/fixture.md", "/tmp/a\\b", "/tmp/a/b", "C:\\Temp\\fixture.md", "\\\\server\\share\\fixture.md"];
    const activateFeature = vi.fn(async () => 1);
    await expect(activateDesktopSmokeFileAction(descriptor(paths), activateFeature)).resolves.toBe(true);
    expect(activateFeature).toHaveBeenCalledWith("typora-workbench", null, expect.objectContaining({
      mediaContent: { kind: "files", paths },
    }));
  });

  it("accepts the exact file-count and UTF-8 byte limits", async () => {
    const paths = [`/${"文".repeat(2730)}x`, ...Array.from({ length: 19 }, (_, index) => `/tmp/fixture-${index}.md`)];
    expect(new TextEncoder().encode(paths[0]).byteLength).toBe(8192);
    const activateFeature = vi.fn(async () => 1);
    await expect(activateDesktopSmokeFileAction(descriptor(paths), activateFeature)).resolves.toBe(true);
    expect(activateFeature).toHaveBeenCalledWith("typora-workbench", null, expect.objectContaining({
      mediaContent: { kind: "files", paths },
    }));
  });
});
