import { invoke } from "@tauri-apps/api/core";
import type { FeatureAction, SearchResult, TaskRun } from "./types";
import type { ShellPanel } from "./uiState";
import { resolveDesktopSmokePluginPanelActivation } from "./desktopSmokePluginPanelActivation";
import { activateDesktopSmokeFileAction, isDesktopSmokeActionExternalPlan } from "./desktopSmokeFileActivation";

type ReleaseSmokeInfo = {
  token: string;
  report_path?: string | null;
};

type ReleaseSmokeProgress = {
  option_z_toggled?: boolean;
  hotkey_show_ms?: number;
  hotkey_toggle_attempt_count?: number;
  hotkey_toggle_success_count?: number;
  search_query?: string;
  search_latency_ms?: number;
  search_result_count?: number;
  settings_page_opened?: boolean;
  plugin_page_opened?: boolean;
  agent_page_opened?: boolean;
  clipboard_copy_tracked?: boolean;
  plugin_activation_feature?: string;
  plugin_activation_ms?: number;
  errors?: string[];
  completed?: boolean;
};

type SmokeActivationOptions = {
  waitForPluginReady?: boolean;
  readyTimeoutMs?: number;
  throwOnError?: boolean;
  expectedPluginId?: string;
  mediaContent?: { kind: "files"; paths: string[] };
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

type SmokePorts = {
  state: SmokeState;
  hasTauriRuntime: () => boolean;
  desktopPluginPanelSmokeEnabled: () => boolean;
  waitForTauriRuntime: () => Promise<boolean>;
  sleep: (ms: number) => Promise<unknown>;
  activateFeature: (code: string, payload?: unknown, options?: SmokeActivationOptions) => Promise<number | null>;
  resizePalette: (height: number) => Promise<void>;
  returnPluginToSearch: () => Promise<void>;
  openSettingsMenu: (menu: "general") => Promise<void>;
  onPanelChange: (panel: ShellPanel) => Promise<void>;
};

export function createDesktopSmokeOrchestration(ports: SmokePorts) {
  const { state } = ports;
  async function activateDesktopSmokePluginPanel() {
    if (!ports.hasTauriRuntime() || !ports.desktopPluginPanelSmokeEnabled() || state.activePlugin) return;
    try {
      const env = import.meta.env as Record<string, unknown>;
      const activation = await resolveDesktopSmokePluginPanelActivation({
        fileTreeHeadAcceptance: String(env.VITE_ATOOLS_FILE_TREE_HEAD_ACCEPTANCE ?? "").trim() === "true",
        loadFileTreeFixture: () => invoke<unknown>("native_panel_fixture"),
        loadCatalogActions: () => invoke<unknown>("desktop_smoke_plugin_panel_actions"),
      });
      if (activation.kind === "none") return;
      if (activation.kind === "file-tree-head") {
        await ports.activateFeature(activation.code, activation.payload, activation.options);
        return;
      }
      if (state.activePlugin) return;
      state.desktopSmokePluginActions = activation.actions;
      await activateDesktopSmokePluginAction(0);
    } catch (error) {
      console.warn("[DesktopSmoke] Failed to activate PluginPanel smoke action:", error);
    }
  }

  async function activateDesktopSmokePluginAction(index: number) {
    const action = state.desktopSmokePluginActions[index];
    if (!action) return;
    state.desktopSmokePluginIndex = index;
    state.activePanel = "home";
    state.query = "";
    state.results = [];
    state.selectedIndex = 0;
    if (await activateDesktopSmokeFileAction(action, ports.activateFeature)) return;
    state.activePlugin = action;
    await ports.resizePalette(action.expand_height);
  }

  async function handleDesktopSmokePluginPanelRender() {
    if (!ports.desktopPluginPanelSmokeEnabled()) return;
    const nextIndex = state.desktopSmokePluginIndex + 1;
    if (nextIndex < state.desktopSmokePluginActions.length) {
      await activateDesktopSmokePluginAction(nextIndex);
    }
  }

  async function runReleaseSmokeSequence() {
    const runtimeReady = await ports.waitForTauriRuntime();
    if (!runtimeReady) return;

    let info: ReleaseSmokeInfo | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        info = await invoke<ReleaseSmokeInfo | null>("release_smoke_info");
        break;
      } catch (error) {
        if (attempt === 9) {
          console.debug("[ReleaseSmoke] command not available:", error);
          return;
        }
        await ports.sleep(120);
      }
    }
    try {
      if (!info?.token) return;
    } catch (error) {
      console.debug("[ReleaseSmoke] command not available:", error);
      return;
    }

    const errors: string[] = [];
    const token = info.token;
    const emitReport = async (patch: ReleaseSmokeProgress) => {
      try {
        await invoke("report_release_smoke_progress", {
          report: {
            token,
            option_z_toggled: patch.option_z_toggled,
            hotkey_show_ms: patch.hotkey_show_ms,
            hotkey_toggle_attempt_count: patch.hotkey_toggle_attempt_count,
            hotkey_toggle_success_count: patch.hotkey_toggle_success_count,
            search_query: patch.search_query,
            search_latency_ms: patch.search_latency_ms,
            search_result_count: patch.search_result_count,
            settings_page_opened: patch.settings_page_opened,
            plugin_page_opened: patch.plugin_page_opened,
            agent_page_opened: patch.agent_page_opened,
            clipboard_copy_tracked: patch.clipboard_copy_tracked,
            plugin_activation_feature: patch.plugin_activation_feature,
            plugin_activation_ms: patch.plugin_activation_ms,
            errors,
            completed: patch.completed ?? false,
          },
        });
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          console.debug("[ReleaseSmoke] report sent", { token, ...patch });
        }
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[ReleaseSmoke] wrapped report failed, retrying legacy payload:", error);
        }
        try {
          await invoke("report_release_smoke_progress", {
            token,
            option_z_toggled: patch.option_z_toggled,
            hotkey_show_ms: patch.hotkey_show_ms,
            hotkey_toggle_attempt_count: patch.hotkey_toggle_attempt_count,
            hotkey_toggle_success_count: patch.hotkey_toggle_success_count,
            search_query: patch.search_query,
            search_latency_ms: patch.search_latency_ms,
            search_result_count: patch.search_result_count,
            settings_page_opened: patch.settings_page_opened,
            plugin_page_opened: patch.plugin_page_opened,
            agent_page_opened: patch.agent_page_opened,
            clipboard_copy_tracked: patch.clipboard_copy_tracked,
            plugin_activation_feature: patch.plugin_activation_feature,
            plugin_activation_ms: patch.plugin_activation_ms,
            errors,
            completed: patch.completed ?? false,
          });
        } catch (legacyError) {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[ReleaseSmoke] failed to report progress:", legacyError);
          }
        }
      }
    };

    let optionZToggled = false;
    let hotkeyShowMs: number | undefined;
    const hotkeyToggleAttemptCount = 5;
    let hotkeyToggleSuccessCount = 0;
    try {
      const probe = await invoke<{
        attemptCount: number;
        successCount: number;
        maxShowMs: number;
      }>("benchmark_main_window_toggle", { attempts: hotkeyToggleAttemptCount });
      hotkeyShowMs = probe.maxShowMs;
      hotkeyToggleSuccessCount = probe.successCount;
      optionZToggled = hotkeyToggleSuccessCount === hotkeyToggleAttemptCount;
    } catch (error) {
      errors.push(`Option+Z smoke failed: ${String(error)}`);
    }
    await emitReport({
      option_z_toggled: optionZToggled,
      hotkey_show_ms: hotkeyShowMs,
      hotkey_toggle_attempt_count: hotkeyToggleAttemptCount,
      hotkey_toggle_success_count: hotkeyToggleSuccessCount,
    });

    let clipboardCopyTracked = false;
    try {
      const priorCopyRunIds = new Set(
        (await invoke<TaskRun[]>("list_task_runs", { limit: 100 }))
          .filter((run) => run.capabilityId === "copy_text")
          .map((run) => run.id),
      );
      await invoke("copy_text", { text: "ATools release smoke" });
      const runs = await invoke<TaskRun[]>("list_task_runs", { limit: 100 });
      const copyRun = runs.find(
        (run) => run.capabilityId === "copy_text" && !priorCopyRunIds.has(run.id),
      );
      const redactedInput = copyRun?.input && typeof copyRun.input === "object" && !Array.isArray(copyRun.input)
        ? copyRun.input as Record<string, unknown>
        : null;
      clipboardCopyTracked = copyRun?.status === "succeeded"
        && redactedInput?.contentRedacted === true
        && redactedInput.characterCount === 20
        && !("text" in redactedInput);
      if (!clipboardCopyTracked) {
        errors.push("Clipboard copy TaskRun did not preserve the redacted input contract");
      }
    } catch (error) {
      errors.push(`Clipboard copy TaskRun smoke failed: ${String(error)}`);
    }
    await emitReport({ clipboard_copy_tracked: clipboardCopyTracked });

    const pluginActivationQuery = "color";
    let searchLatencyMs: number | undefined;
    let searchResultCount: number | undefined;
    let pluginActivationFeature: string | undefined;
    let pluginActivationMs: number | undefined;
    try {
      await invoke("show_main_window");
      const searchStartedAt = performance.now();
      const pluginCandidates = await invoke<SearchResult[]>("search_features", { query: pluginActivationQuery });
      searchLatencyMs = performance.now() - searchStartedAt;
      searchResultCount = pluginCandidates.length;
      const pluginCandidate = pluginCandidates.find((candidate) => candidate.plugin_id && candidate.code);
      if (!pluginCandidate) {
        throw new Error(`No plugin feature matched ${pluginActivationQuery}`);
      }
      pluginActivationFeature = pluginCandidate.code;
      const measured = await ports.activateFeature(pluginCandidate.code, null, {
        waitForPluginReady: true,
        readyTimeoutMs: 10000,
        throwOnError: true,
        expectedPluginId: pluginCandidate.plugin_id,
      });
      if (!Number.isFinite(measured) || measured === null || measured <= 0) {
        throw new Error(`Plugin activation returned an invalid duration: ${String(measured)}`);
      }
      pluginActivationMs = measured;
    } catch (error) {
      errors.push(`Plugin cold activation smoke failed: ${String(error)}`);
    } finally {
      if (state.activePlugin) {
        await ports.returnPluginToSearch();
      }
      try {
        await invoke("hide_main_window");
      } catch (error) {
        errors.push(`Plugin cold activation cleanup failed: ${String(error)}`);
      }
    }
    await emitReport({
      search_query: pluginActivationQuery,
      search_latency_ms: searchLatencyMs,
      search_result_count: searchResultCount,
      plugin_activation_feature: pluginActivationFeature,
      plugin_activation_ms: pluginActivationMs,
    });

    let settingsOpened = false;
    try {
      await ports.openSettingsMenu("general");
      settingsOpened = state.activePanel === "settings";
      if (!settingsOpened) {
        errors.push("Settings panel did not become active");
      }
    } catch (error) {
      errors.push(`Settings panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ settings_page_opened: settingsOpened });
      await ports.onPanelChange("home");
    }

    let pluginOpened = false;
    try {
      await ports.onPanelChange("plugins");
      pluginOpened = state.activePanel === "plugins";
      if (!pluginOpened) {
        errors.push("Plugins panel did not become active");
      }
    } catch (error) {
      errors.push(`Plugins panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ plugin_page_opened: pluginOpened });
      await ports.onPanelChange("home");
    }

    let agentOpened = false;
    try {
      await ports.onPanelChange("agent");
      agentOpened = state.activePanel === "agent";
      if (!agentOpened) {
        errors.push("Agent panel did not become active");
      }
    } catch (error) {
      errors.push(`Agent panel smoke failed: ${String(error)}`);
    } finally {
      await emitReport({ agent_page_opened: agentOpened });
      await ports.onPanelChange("home");
      await emitReport({ completed: true });
    }
  }


  return {
    activateDesktopSmokePluginPanel,
    activateDesktopSmokePluginAction,
    handleDesktopSmokePluginPanelRender,
    desktopSmokeActionExternalPlan: (action: FeatureAction | null) => isDesktopSmokeActionExternalPlan(
      action,
      state.desktopSmokePluginActions,
      state.desktopSmokePluginIndex,
    ),
    runReleaseSmokeSequence,
  };
}
