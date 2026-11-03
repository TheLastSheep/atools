import { invoke } from "@tauri-apps/api/core";
import { buildWebQuickOpenUrl, webQuickOpenEntryByCode } from "./webQuickOpen";
import { localLaunchEntryByCode } from "./localLaunch";
import { urlFromQuickOpenCode } from "./urlQuickOpen";
import { launcherSystemSearchActionByCode, type LauncherSystemDestination } from "./launcherSystemSearchActions";
import type { LauncherMediaInput } from "./launcherMediaContext";
import type { FeatureAction, SearchResult } from "./types";
import type { MainPushCandidate } from "./pluginMainPushProtocol";
import type { PluginOpenOutcome } from "./pluginOpen";
import type { LauncherPendingPluginActivationStore, PendingPluginActivation } from "./launcherPendingPluginActivation.svelte";



type ActivationWaiter = {
  featureCode: string;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (durationMs: number) => void;
  reject: (error: Error) => void;
};

type PluginLifecycle = ReturnType<typeof import("./pluginCodeLifecycle").createPluginCodeLifecycle>;
type ContentSearch = ReturnType<typeof import("./launcherContentSearch").createLauncherContentSearch>;
type MediaSearch = ReturnType<typeof import("./launcherMediaSearch").createLauncherMediaSearch>;

type SessionState = {
  activePlugin: FeatureAction | null;
  pluginActivationError: string;
  results: SearchResult[];
  selectedIndex: number;
  searchRunId: number;
  pluginLifecycleNotice: import("./pluginCodeLifecycle").PluginCodeChange | null;
  webQuickOpenEntries: import("./webQuickOpen").WebQuickOpenEntry[];
  localLaunchEntries: import("./localLaunch").LocalLaunchEntry[];
};

type SessionPorts = {
  state: SessionState;
  pendingPluginActivation: LauncherPendingPluginActivationStore;
  pluginCodeLifecycle: Pick<PluginLifecycle, "beginActivation" | "captureActivation" | "start" | "isCurrent">;
  contentSearch: Pick<ContentSearch, "clear">;
  mediaSearch: Pick<MediaSearch, "cancelIntake" | "clear">;
  returnCoordinator: { invalidate: () => void; returnToSearch: () => Promise<void> };
  returnContext: { clear: () => void };
  isDetachWindow: boolean;
  openPluginDetachAction: (action: FeatureAction, isCurrent?: () => boolean) => Promise<boolean>;
  getMainPushHostInstance: () => { closePromoted: () => Promise<void>; releaseForForeground?: (selectedRunnerId?: string) => Promise<void> } | null;
  activateSystemDestination: (destination: LauncherSystemDestination) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  openLocalLaunchEntry: (entry: import("./localLaunch").LocalLaunchEntry) => Promise<void>;
  openLocalAppPath: (path: string) => Promise<void>;
  activatePastedResult: (result: SearchResult) => Promise<void>;
  activateTextQuickAction: (result: SearchResult) => Promise<void>;
};

export function createLauncherPluginSessionController(ports: SessionPorts) {
  const { state } = ports;
  let pluginActivationWaiter: ActivationWaiter | null = null;
  async function activateFeature(
    code: string,
    payload?: unknown,
    options: {
      waitForPluginReady?: boolean;
      readyTimeoutMs?: number;
      throwOnError?: boolean;
      expectedPluginId?: string;
      shortcutDispatchId?: string;
      textContent?: string;
      mediaContent?: LauncherMediaInput;
      onOwnerValidated?: (action: FeatureAction) => void;
      onCommitted?: (action: FeatureAction) => void;
      onOutcome?: (outcome: PluginOpenOutcome) => void;
      preserveLauncherReturnContext?: boolean;
      isCancelled?: () => boolean;
      pendingPluginActivation?: PendingPluginActivation;
      promoteMainPush?: (action: FeatureAction) => void;
      closeMainPushRunner?: () => Promise<void> | void;
      detachedEntryType?: "regex" | "over";
    } = {},
  ): Promise<number | null> {
    // A delayed native shortcut must claim its exact ticket before this controller
    // invalidates other work, changes UI state, or begins plugin lifecycle work.
    let shortcutAction: FeatureAction | undefined;
    if (options.shortcutDispatchId) {
      if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
      try {
        await ports.pluginCodeLifecycle.start();
        if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
        const snapshot = ports.pluginCodeLifecycle.captureActivation();
        shortcutAction = await invoke<FeatureAction>("activate_feature", {
          code, payload: payload ?? null, expectedPluginId: options.expectedPluginId,
          shortcutDispatchId: options.shortcutDispatchId,
        });
        if (!ports.pluginCodeLifecycle.isCurrent(snapshot, shortcutAction.plugin_id)) {
          options.onOutcome?.({ status: "superseded" });
          return null;
        }
      } catch (error) {
        options.onOutcome?.({ status: "failed", reason: "activation-failed" });
        if (options.throwOnError) throw error;
        return null;
      }
      if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
    }
    const pendingAttempt = options.pendingPluginActivation;
    if (!pendingAttempt || !ports.pendingPluginActivation.isCurrent(pendingAttempt)) {
      ports.pendingPluginActivation.cancel();
    }
    // A new open intent supersedes any return still waiting for its resize.
    ports.returnCoordinator.invalidate();
    // A plugin result carries an explicit owner. Its feature code can collide
    // with an app shortcut, so owned activations must reach native owner checks.
    const canUseAppShortcut = !options.expectedPluginId;
    if (canUseAppShortcut && (code === "paste-clipboard" || code === "clipboard")) {
      await invoke("open_pasteboard_shelf_window");
      await invoke("hide_main_window");
      return null;
    }
    if (canUseAppShortcut && code.startsWith("system:")) {
      const action = launcherSystemSearchActionByCode(code);
      if (action) await ports.activateSystemDestination(action.destination);
      return null;
    }

    if (canUseAppShortcut && code.startsWith("web:")) {
      const entry = webQuickOpenEntryByCode(code, state.webQuickOpenEntries);
      if (entry) {
        await ports.openUrl(buildWebQuickOpenUrl(entry, ""));
      }
      return null;
    }

    if (canUseAppShortcut && code.startsWith("local:")) {
      const entry = localLaunchEntryByCode(code, state.localLaunchEntries);
      if (entry) {
        await ports.openLocalLaunchEntry(entry);
      }
      return null;
    }

    if (canUseAppShortcut && code.startsWith("local-app:")) {
      await ports.openLocalAppPath(code.slice("local-app:".length));
      return null;
    }

    if (canUseAppShortcut && code.startsWith("paste:")) {
      const result = state.results.find((item) => item.code === code);
      if (result) {
        await ports.activatePastedResult(result);
      }
      return null;
    }

    if (canUseAppShortcut && code.startsWith("url:")) {
      const url = urlFromQuickOpenCode(code);
      if (url) {
        await ports.openUrl(url);
      }
      return null;
    }

    if (canUseAppShortcut && code.startsWith("text:")) {
      const result = state.results.find((item) => item.code === code);
      if (result) {
        await ports.activateTextQuickAction(result);
      }
      return null;
    }

    ports.mediaSearch.cancelIntake();
    const activationStartedAt = performance.now();
    const activation = ports.pluginCodeLifecycle.beginActivation();
    state.pluginActivationError = "";
    try {
      await ports.pluginCodeLifecycle.start();
      if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
      if (!ports.pluginCodeLifecycle.isCurrent(activation)) { options.onOutcome?.({ status: "superseded" }); return null; }
      const action = shortcutAction ?? await invoke<FeatureAction>(options.mediaContent?.kind === "files" ? "activate_file_content_feature" : options.mediaContent?.kind === "img" ? "activate_image_content_feature" : options.textContent !== undefined ? "activate_text_content_feature" : "activate_feature", {
        code,
        ...(options.mediaContent?.kind === "files" ? {paths: options.mediaContent.paths} : options.mediaContent?.kind === "img" ? {dataUrl: options.mediaContent.dataUrl} : options.textContent !== undefined ? { content: options.textContent } : { payload: payload ?? null }),
        ...(options.expectedPluginId ? { expectedPluginId: options.expectedPluginId } : {}),
        ...(options.shortcutDispatchId ? { shortcutDispatchId: options.shortcutDispatchId } : {}),
      });
      if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
      if (options.expectedPluginId && action.plugin_id !== options.expectedPluginId) {
        throw new Error("FEATURE_OWNER_CHANGED: activate_feature returned a different owner");
      }
      if (!ports.pluginCodeLifecycle.isCurrent(activation, action.plugin_id)) { options.onOutcome?.({ status: "superseded" }); return null; }
      options.onOwnerValidated?.(action);

      // Release smoke explicitly measures the main WebView activation boundary.
      // Detached windows also claim an existing action and must never detach again.
      const shouldAutoDetach = action.auto_detach === true
        && !ports.isDetachWindow
        && !options.waitForPluginReady;
      if (shouldAutoDetach) {
        let detached = false;
        const detachAction = options.detachedEntryType
          ? { ...action, entry_type: options.detachedEntryType }
          : action;
        try {
          const opened = await ports.openPluginDetachAction(detachAction,
            () => !options.isCancelled?.() && ports.pluginCodeLifecycle.isCurrent(activation, action.plugin_id));
          if (!opened) {
            options.onOutcome?.({ status: "superseded" });
            return null;
          }
          detached = true;
    } catch (error) {
          // The same owner-validated action remains available for the normal main-panel fallback.
          if (String(error instanceof Error ? error.message : error).includes("PLUGIN_DETACH_WINDOW_OCCUPIED")) {
            state.pluginActivationError = "分离窗口正在使用，已在当前面板打开。";
          }
          console.warn("Auto-detach failed; opening the plugin in the launcher panel.", error);
        }
        if (options.isCancelled?.() || !ports.pluginCodeLifecycle.isCurrent(activation, action.plugin_id)) {
          options.onOutcome?.({ status: "superseded" });
          return null;
        }
        if (detached) {
          if (!options.preserveLauncherReturnContext) ports.returnContext.clear();
          state.searchRunId += 1;
          ports.contentSearch.clear();
          ports.mediaSearch.clear();
          state.results = [];
          state.selectedIndex = 0;
          state.pluginLifecycleNotice = null;
          if (pendingAttempt) ports.pendingPluginActivation.clear(pendingAttempt);
          options.onOutcome?.({ status: "committed" });
          // History capture uses the same commit identity as a main activation,
          // but the action is restored synchronously so no launcher panel mounts.
          const previousActivePlugin = state.activePlugin;
          state.activePlugin = detachAction;
          try {
            options.onCommitted?.(detachAction);
          } catch (error) {
            console.warn("Failed to capture detached plugin activation history.", error);
          } finally {
            state.activePlugin = previousActivePlugin;
          }
          // Main-push transfers are only promoted on fallback. Close just the
          // selected hidden runner after commit; its intentional closing state
          // must not be mistaken for a superseded activation.
          try { await options.closeMainPushRunner?.(); }
          catch (error) { console.warn("Failed to close selected main-push runner after detach.", error); }
          if (!ports.pluginCodeLifecycle.isCurrent(activation, action.plugin_id)) return null;
          try { await ports.returnCoordinator.returnToSearch(); }
          catch (error) { console.warn("Failed to return launcher to search after detached activation.", error); }
          return null;
        }
      }

      if (options.promoteMainPush) options.promoteMainPush(action);
      else {
        const mainPush = ports.getMainPushHostInstance();
        if (mainPush?.releaseForForeground) await mainPush.releaseForForeground();
        else await mainPush?.closePromoted();
        if (options.isCancelled?.() || !ports.pluginCodeLifecycle.isCurrent(activation, action.plugin_id)) { options.onOutcome?.({ status: "superseded" }); return null; }
      }
      const ready = options.waitForPluginReady
        ? waitForPluginActivation(action.feature_code, activationStartedAt, options.readyTimeoutMs ?? 10000)
        : null;
      state.searchRunId += 1; ports.contentSearch.clear(); ports.mediaSearch.clear();
      if (!options.preserveLauncherReturnContext) ports.returnContext.clear();
      state.activePlugin = action;
      // The open is committed now. Do not keep advertising Escape as a cancel
      // action while window expansion waits; clear only this attempt so a later
      // open intent remains visible when this promise eventually settles.
      if (pendingAttempt) ports.pendingPluginActivation.clear(pendingAttempt);
      options.onOutcome?.({ status: "committed" });
      options.onCommitted?.(action);
      state.pluginLifecycleNotice = null;
      state.results = [];
      state.selectedIndex = 0;
      try {
        await invoke("expand_window", { height: action.expand_height });
      } catch (e) {
        console.warn("Failed to expand window:", e);
      }
      return ready ? await ready : null;
    } catch (e) {
      if (options.isCancelled?.()) { options.onOutcome?.({ status: "superseded" }); return null; }
      if (!ports.pluginCodeLifecycle.isCurrent(activation)) { options.onOutcome?.({ status: "superseded" }); return null; }
      cancelPluginActivationWaiter(e instanceof Error ? e : new Error(String(e)));
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("FEATURE_OWNER_CHANGED:")) {
        state.pluginActivationError = options.onOutcome ? "" : "此功能的来源已变化，请刷新后重新打开。";
      } else state.pluginActivationError = options.onOutcome ? "" : "插件未能打开，请检查插件状态后重试。";
      options.onOutcome?.({ status: "failed", reason: "activation-failed" });
      if (options.throwOnError) throw e;
      console.error("Plugin activation failed.");
      return null;
    } finally {
      if (pendingAttempt) ports.pendingPluginActivation.clear(pendingAttempt);
    }
  }

  function expectedLauncherPluginId(target: { code: string; plugin_id?: string; plugin_name?: string } | null | undefined) {
    if (!target?.plugin_id) return undefined;
    const isAppSystemAction = target.plugin_id === "system"
      && target.plugin_name === "ATools"
      && launcherSystemSearchActionByCode(target.code) !== null;
    return isAppSystemAction ? undefined : target.plugin_id;
  }

  async function activateMainPush(
    candidate: MainPushCandidate,
    query: string,
    commit: (action: FeatureAction) => void,
    isCurrent: () => boolean,
    closeSelectedRunner: () => Promise<void>,
  ): Promise<void> {
    await activateFeature(candidate.featureCode, query, {
      expectedPluginId: candidate.pluginId,
      isCancelled: () => !isCurrent(),
      promoteMainPush: commit,
      closeMainPushRunner: closeSelectedRunner,
      ...(candidate.commandType === "text" ? {} : { detachedEntryType: candidate.commandType }),
    });
  }

  function waitForPluginActivation(featureCode: string, startedAt: number, timeoutMs: number) {
    cancelPluginActivationWaiter(new Error("Plugin activation was superseded"));
    return new Promise<number>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (pluginActivationWaiter?.featureCode !== featureCode) return;
        pluginActivationWaiter = null;
        reject(new Error(`Plugin ${featureCode} did not reach the host iframe load boundary within ${timeoutMs}ms`));
      }, timeoutMs);
      pluginActivationWaiter = { featureCode, startedAt, timeoutId, resolve, reject };
    });
  }

  function cancelPluginActivationWaiter(error: Error) {
    const waiter = pluginActivationWaiter;
    if (!waiter) return;
    pluginActivationWaiter = null;
    clearTimeout(waiter.timeoutId);
    waiter.reject(error);
  }

  function handlePluginReady(featureCode: string) {
    const waiter = pluginActivationWaiter;
    if (!waiter || waiter.featureCode !== featureCode) return;
    pluginActivationWaiter = null;
    clearTimeout(waiter.timeoutId);
    waiter.resolve(performance.now() - waiter.startedAt);
  }


  return {
    activateFeature,
    activateMainPush,
    expectedLauncherPluginId,
    waitForPluginActivation,
    cancelPluginActivationWaiter,
    handlePluginReady,
  };
}
