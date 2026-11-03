import { invoke } from "@tauri-apps/api/core";
import type { DesktopSmokeFilesActivation, DesktopSmokeImageStitchActivation } from "./desktopSmokeFilesActivationContract";
import { isDesktopSmokeActionExternalPlan } from "./desktopSmokeFileActivation";
import type { FeatureAction, SearchResult } from "./types";
import type { ShellPanel } from "./uiState";

type DesktopSmokeFeatureActivator = (
  code: string,
  payload?: unknown,
  options?: {
    waitForPluginReady?: boolean;
    readyTimeoutMs?: number;
    throwOnError?: boolean;
    expectedPluginId?: string;
    mediaContent?: { kind: "files"; paths: string[] };
    isCancelled?: () => boolean;
  },
) => Promise<number | null>;

type DesktopSmokeDeepReadFilesActivationPort = {
  publishReady: (onReady: (activation: DesktopSmokeFilesActivation) => void) => boolean;
  dispose: () => void;
};
type DesktopSmokeImageStitchFilesActivationPort = {
  publishReady: (onReady: (activation: DesktopSmokeImageStitchActivation) => void) => boolean;
  dispose: () => void;
};

type SmokeState = {
  activePlugin: FeatureAction | null;
  desktopSmokePluginActions: FeatureAction[];
  desktopSmokePluginIndex: number;
  activePanel: ShellPanel;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
};

type SmokeOrchestration = {
  activateDesktopSmokePluginPanel: () => Promise<void>;
  handleDesktopSmokePluginPanelRender: () => Promise<void>;
  desktopSmokeActionExternalPlan: (action: FeatureAction | null) => boolean;
  runReleaseSmokeSequence: () => Promise<void>;
};

type Options = {
  state: SmokeState;
  hasTauriRuntime: () => boolean;
  waitForTauriRuntime: () => Promise<boolean>;
  sleep: (ms: number) => Promise<unknown>;
  activateFeature: DesktopSmokeFeatureActivator;
  onDesktopSmokeFilesActivationReady?: (activate: DesktopSmokeFilesActivation) => void;
  resizePalette: (height: number) => Promise<void>;
  returnPluginToSearch: () => Promise<void>;
  openSettingsMenu: (menu: "general") => Promise<void>;
  onPanelChange: (panel: ShellPanel) => Promise<void>;
};

export function createLauncherDesktopSmokeHost(options: Options) {
  let orchestrationPromise: Promise<SmokeOrchestration> | null = null;
  let deepReadActivationPort: DesktopSmokeDeepReadFilesActivationPort | null = null;
  let imageStitchActivationPort: DesktopSmokeImageStitchFilesActivationPort | null = null;
  let deepReadActivation: DesktopSmokeFilesActivation | null = null;
  let imageStitchActivation: DesktopSmokeImageStitchActivation | null = null;
  let deepReadActivationPortPromise: Promise<void> | null = null;
  let imageStitchActivationPortPromise: Promise<void> | null = null;
  let disposed = false;

  function enabled() {
    const env = import.meta.env as Record<string, unknown>;
    const value = String(env.VITE_ATOOLS_DESKTOP_SMOKE ?? "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  }

  function deepReadFilesFixtureEnabled() {
    const env = import.meta.env as Record<string, unknown>;
    return env.VITE_ATOOLS_DEEPREAD_FILES_SMOKE === "true";
  }

  function imageStitchFilesFixtureEnabled() {
    const env = import.meta.env as Record<string, unknown>;
    return env.VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE === "true";
  }

  function deepReadActivationEnabled() {
    return enabled() || deepReadFilesFixtureEnabled();
  }

  function filesActivationEnabled() {
    return enabled() || deepReadFilesFixtureEnabled() || imageStitchFilesFixtureEnabled();
  }

  function imageStitchActivationEnabled() {
    return enabled() || imageStitchFilesFixtureEnabled();
  }

  async function loadDeepReadActivationPort() {
    if (deepReadActivation || disposed || !deepReadActivationEnabled()) return;
    if (!deepReadActivationPortPromise) {
      const pending = import("./desktopSmokeDeepReadFilesActivationPort").then(({ createDesktopSmokeDeepReadFilesActivationPort }) => {
        if (disposed || !deepReadActivationEnabled()) return;
        deepReadActivationPort = createDesktopSmokeDeepReadFilesActivationPort({
          desktopSmokeEnabled: deepReadActivationEnabled,
          activateFeature: options.activateFeature,
        });
        deepReadActivationPort.publishReady(value => { deepReadActivation = value; });
      }).catch(error => {
        if (deepReadActivationPortPromise === pending) deepReadActivationPortPromise = null;
        deepReadActivationPort?.dispose();
        deepReadActivationPort = null;
        deepReadActivation = null;
        throw error;
      });
      deepReadActivationPortPromise = pending;
    }
    await deepReadActivationPortPromise;
  }

  async function loadImageStitchActivationPort() {
    if (imageStitchActivation || disposed) return;
    if (!imageStitchActivationPortPromise) {
      const pending = import("./desktopSmokeImageStitchFilesActivationPort").then(({ createDesktopSmokeImageStitchFilesActivationPort }) => {
        if (disposed || !imageStitchActivationEnabled()) return;
        imageStitchActivationPort = createDesktopSmokeImageStitchFilesActivationPort({
          desktopSmokeEnabled: imageStitchActivationEnabled,
          readFixtureEvidence: () => invoke<unknown>("native_published_image_stitch_fixture"),
          activateFeature: options.activateFeature,
        });
        imageStitchActivationPort.publishReady(value => { imageStitchActivation = value; });
      }).catch(error => {
        if (imageStitchActivationPortPromise === pending) imageStitchActivationPortPromise = null;
        imageStitchActivationPort?.dispose();
        imageStitchActivationPort = null;
        imageStitchActivation = null;
        throw error;
      });
      imageStitchActivationPortPromise = pending;
    }
    await imageStitchActivationPortPromise;
  }

  async function activateDesktopSmokeFiles(code: string, paths: readonly [string], expectedPluginId: string): Promise<void>;
  async function activateDesktopSmokeFiles(code: "image-stitch-files", paths: readonly [string, string], expectedPluginId: "image-stitch", runId: string): Promise<void>;
  async function activateDesktopSmokeFiles(code: string, paths: readonly string[], expectedPluginId: string, runId?: string) {
    if (disposed || !filesActivationEnabled()) throw new Error("Desktop smoke activation scope is unavailable");
    if (code === "deepread-import" && expectedPluginId === "deepread" && paths.length === 1 && runId === undefined) {
      if (!deepReadActivationEnabled()) throw new Error("DeepRead desktop smoke activation scope is unavailable");
      await loadDeepReadActivationPort();
      if (disposed || !deepReadActivationEnabled() || !deepReadActivation) throw new Error("Desktop smoke activation scope is unavailable");
      await deepReadActivation(code, paths as readonly [string], expectedPluginId);
      return;
    }
    if (code === "image-stitch-files" && expectedPluginId === "image-stitch" && paths.length === 2
      && typeof runId === "string" && runId.length > 0) {
      if (!imageStitchActivationEnabled()) throw new Error("Image Stitch desktop smoke activation scope is unavailable");
      await loadImageStitchActivationPort();
      if (disposed || !imageStitchActivationEnabled() || !imageStitchActivation) throw new Error("Image Stitch desktop smoke activation scope is unavailable");
      await imageStitchActivation(code, paths as readonly [string, string], expectedPluginId, runId);
      return;
    }
    throw new Error("Desktop smoke activation identity or tuple is outside its fixed route");
  }

  const activateFiles: DesktopSmokeFilesActivation = activateDesktopSmokeFiles;

  /* Existing App callback remains single and opt-in; this dispatcher serves exact owned routes. */
  if (!disposed && filesActivationEnabled()) options.onDesktopSmokeFilesActivationReady?.(activateFiles);

  function load() {
    if (!orchestrationPromise) {
      const pending = import("./desktopSmokeOrchestration").then(({ createDesktopSmokeOrchestration }) =>
        createDesktopSmokeOrchestration({
          state: options.state,
          hasTauriRuntime: options.hasTauriRuntime,
          desktopPluginPanelSmokeEnabled: enabled,
          waitForTauriRuntime: options.waitForTauriRuntime,
          sleep: options.sleep,
          activateFeature: options.activateFeature,
          resizePalette: options.resizePalette,
          returnPluginToSearch: options.returnPluginToSearch,
          openSettingsMenu: options.openSettingsMenu,
          onPanelChange: options.onPanelChange,
        }),
      ).catch(error => {
        if (orchestrationPromise === pending) orchestrationPromise = null;
        throw error;
      });
      orchestrationPromise = pending;
    }
    return orchestrationPromise;
  }

  async function run(operation: (smoke: SmokeOrchestration) => Promise<void>, label: string) {
    try { await operation(await load()); }
    catch (error) { console.warn(`[DesktopSmoke] ${label} failed:`, error); }
  }

  return {
    enabled,
    activateDesktopSmokePluginPanel: () => run(smoke => smoke.activateDesktopSmokePluginPanel(), "plugin panel startup"),
    handleDesktopSmokePluginPanelRender: () => run(smoke => smoke.handleDesktopSmokePluginPanelRender(), "plugin panel progression"),
    runReleaseSmokeSequence: () => run(smoke => smoke.runReleaseSmokeSequence(), "release sequence"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deepReadActivationPort?.dispose();
      imageStitchActivationPort?.dispose();
      deepReadActivationPort = null;
      imageStitchActivationPort = null;
      deepReadActivation = null;
      imageStitchActivation = null;
    },
    desktopSmokeActionExternalPlan: (action: FeatureAction | null) => isDesktopSmokeActionExternalPlan(
      action,
      options.state.desktopSmokePluginActions,
      options.state.desktopSmokePluginIndex,
    ),
  };
}
