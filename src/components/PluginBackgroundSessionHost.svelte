<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import PluginPanelMount from "./PluginPanelMount.svelte";
  import type { FeatureAction } from "../lib/types";
  import type { PluginPanelMountExports, PluginPanelMountProps } from "../lib/pluginPanelMount";
  import { createPluginBackgroundSessionPool, type PluginBackgroundSessionView } from "../lib/pluginBackgroundSessionPool";
  import { getPluginRuntimeControl } from "../lib/pluginRuntimeControl";
  import { runtimeSessionId, type RuntimeSession } from "../lib/pluginRuntimeInventory";

  type Props = {
    enabled: boolean;
    activeAction: FeatureAction | null;
    mainPushPromotedId: string | null;
    panelPropsForAction: (action: FeatureAction) => PluginPanelMountProps;
    onPanelInstance: (instance: PluginPanelMountExports | null) => void;
    onManagedPlugins: (pluginIds: string[]) => void;
    releaseMainPushForForeground: (preservedRunnerId?: string) => Promise<void>;
    onInvalidated: (pluginId: string | null) => void;
    invoke: typeof import("@tauri-apps/api/core").invoke;
    listen: <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
  };
  let { enabled, activeAction, mainPushPromotedId, panelPropsForAction, onPanelInstance, onManagedPlugins,
    releaseMainPushForForeground, onInvalidated, invoke, listen }: Props = $props();
  let sessions = $state<PluginBackgroundSessionView[]>([]);
  const panelInstances = new Map<string, PluginPanelMountExports>();
  const panelProps = new Map<string, PluginPanelMountProps>();
  const panelInstanceHandlers = new Map<string, (instance: PluginPanelMountExports | null) => void>();
  let pool: ReturnType<typeof createPluginBackgroundSessionPool> | undefined;
  const runtimeControl = getPluginRuntimeControl();
  const runtimeSourceId = Symbol("plugin-background-host");
  let unregisterRuntimeSource: (() => void) | undefined;
  let lastForegroundAction: FeatureAction | null = null;
  let lastForegroundStage = "";
  let publishedSession: string | null = null;

  function publishPanel(sessionId: string, visible: boolean) {
    if (visible) {
      const instance = panelInstances.get(sessionId) ?? null;
      if (instance) { publishedSession = sessionId; onPanelInstance(instance); }
    } else if (publishedSession === sessionId) {
      publishedSession = null; onPanelInstance(null);
    }
  }

  function propsFor(session: PluginBackgroundSessionView): PluginPanelMountProps {
    const existing = panelProps.get(session.sessionId);
    if (existing) return existing;
    const base = panelPropsForAction(session.action);
    const props: PluginPanelMountProps = {
      ...base, action: session.action, persistentSessionId: session.sessionId, persistentVisible: false,
      onclose: isKill => {
        if (isKill === true) {
          const stopping = pool?.stop(session.sessionId) ?? Promise.resolve();
          void base.onclose(false);
          return stopping;
        }
        return base.onclose(false);
      },
      onready: () => { pool?.panelReady(session.sessionId); return base.onready?.(); },
      onloaderror: error => { void pool?.panelFailed(session.sessionId, error); },
      onbackgroundwaiting: waiting => { void pool?.setWaiting(session.sessionId, waiting); },
    };
    panelProps.set(session.sessionId, props);
    return props;
  }

  function instanceHandler(sessionId: string) {
    let handler = panelInstanceHandlers.get(sessionId);
    if (handler) return handler;
    handler = instance => {
      if (instance) panelInstances.set(sessionId, instance);
      else panelInstances.delete(sessionId);
      publishPanel(sessionId, sessions.find(item => item.sessionId === sessionId)?.visible === true);
    };
    panelInstanceHandlers.set(sessionId, handler);
    return handler;
  }

  function runtimePhase(session: PluginBackgroundSessionView): RuntimeSession["phase"] {
    switch (session.stage) {
      case "admitting":
      case "loading": return "starting";
      case "ready": return "ready";
      case "stopping": return "stopping";
      case "cleanup-failed": return "cleanup_failed";
      default: return "unknown";
    }
  }

  function runtimeRow(session: PluginBackgroundSessionView): RuntimeSession {
    return {
      id: runtimeSessionId("background", "main", session.sessionId),
      kind: "background",
      instanceId: session.sessionId,
      pluginId: session.pluginId,
      windowLabel: "main",
      codeRevision: session.codeRevision,
      phase: runtimePhase(session),
      evidence: "renderer_view",
    };
  }

  function matchesRuntimeOwner(session: PluginBackgroundSessionView, row: RuntimeSession) {
    return row.kind === "background" && row.windowLabel === "main" && row.evidence === "renderer_view"
      && row.instanceId === session.sessionId && row.pluginId === session.pluginId
      && row.codeRevision === session.codeRevision
      && row.id === runtimeSessionId("background", "main", session.sessionId);
  }

  async function stopRuntimeOwner(row: RuntimeSession) {
    if (row.phase !== "ready" || row.kind !== "background" || row.windowLabel !== "main"
      || row.evidence !== "renderer_view" || row.id !== runtimeSessionId("background", "main", row.instanceId)) {
      throw new Error("ERR_PLUGIN_RUNTIME_STALE");
    }
    const owner = pool?.snapshot().find(session => matchesRuntimeOwner(session, row) && session.stage === "ready");
    if (!owner || !pool) throw new Error("ERR_PLUGIN_RUNTIME_STALE");
    await pool.stop(owner.sessionId);
    if (pool.snapshot().some(session => session.sessionId === row.instanceId)) {
      throw new Error("ERR_PLUGIN_RUNTIME_STOP_UNCONFIRMED");
    }
  }

  export function retryCleanup(sessionId: string) {
    return pool?.retryCleanup(sessionId) ?? Promise.resolve(false);
  }

  pool = untrack(() => createPluginBackgroundSessionPool({
    invoke, listen, changed: value => {
      const previous = new Map(sessions.map(session => [session.sessionId, session]));
      sessions = value;
      onManagedPlugins([...new Set(value.map(session => session.pluginId))]);
      for (const session of value) {
        propsFor(session);
        publishPanel(session.sessionId, session.visible);
      }
      for (const id of previous.keys()) if (!value.some(session => session.sessionId === id)) {
        panelProps.delete(id); panelInstanceHandlers.delete(id); panelInstances.delete(id); publishPanel(id, false);
      }
      runtimeControl?.changed();
    },
    releaseTransientForPanel: preservedRunnerId => releaseMainPushForForeground(preservedRunnerId),
    preservedMainPushRunnerId: () => mainPushPromotedId ?? undefined,
    closePanelStrict: async (sessionId, retry = false) => {
      await panelInstances.get(sessionId)?.closePersistentStrict?.({ retry });
    },
    activatePanel: (sessionId, action) => panelInstances.get(sessionId)?.activatePersistentEntry?.(action) ?? false,
    setPanelVisible: (sessionId, visible) => { void panelInstances.get(sessionId)?.setPersistentVisible?.(visible); publishPanel(sessionId, visible); },
    onInvalidated,
  }));
  unregisterRuntimeSource = runtimeControl?.registerSource(runtimeSourceId, {
    snapshot: () => pool?.snapshot().map(runtimeRow) ?? [],
    stop: stopRuntimeOwner,
  });

  $effect(() => {
    if (enabled) void pool?.connect().catch(error => console.warn("[PluginBackground] host startup failed:", error));
  });

  $effect(() => {
    const action = activeAction;
    if (!action) {
      lastForegroundAction = null;
      lastForegroundStage = "";
      void pool?.hideAllExcept();
      return;
    }
    const matching = sessions.find(session => session.pluginId === action.plugin_id);
    const stage = matching ? `${matching.stage}:${matching.mountReady}` : "none";
    if (mainPushPromotedId) {
      lastForegroundAction = action;
      lastForegroundStage = stage;
      void pool?.hideAllExcept();
      return;
    }
    if (action === lastForegroundAction && stage === lastForegroundStage) return;
    lastForegroundAction = action;
    lastForegroundStage = stage;
    void pool?.foreground(action);
  });

  onDestroy(() => {
    const closing = pool?.close();
    if (closing) {
      void closing.then(() => {
        unregisterRuntimeSource?.();
        unregisterRuntimeSource = undefined;
      }).catch(() => console.warn("[PluginBackground] strict session cleanup failed during unmount"));
    } else {
      unregisterRuntimeSource?.();
      unregisterRuntimeSource = undefined;
    }
    onManagedPlugins([]);
  });
</script>

<div class="background-session-host">
  {#each sessions as session (session.sessionId)}
    {@const props = propsFor(session)}
    {#if session.mountReady && session.stage !== "admitting"}
      <div class="background-session-slot" class:visible={session.visible} data-session-visible={session.visible}
        style="position:absolute; inset:0; width:100%; height:100%">
        <PluginPanelMount action={props.action} panelProps={props} oninstance={instanceHandler(session.sessionId)} />
      </div>
    {/if}
  {/each}
</div>

<style>
  .background-session-host { position: fixed; inset: 0; z-index: 10; pointer-events: none; }
  .background-session-slot { pointer-events: none; }
  .background-session-slot.visible { pointer-events: auto; }
  .background-session-slot.visible :global(.plugin-panel:not(.persistent-hidden)) {
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 18px;
    opacity: var(--atools-window-opacity, 1);
    box-shadow: 0 30px 78px -28px rgba(0, 0, 0, 0.46), 0 12px 30px -24px rgba(0, 0, 0, 0.5),
      0 1px 0 rgba(255, 255, 255, 0.38) inset;
  }
</style>
