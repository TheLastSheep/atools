<script lang="ts">
  import { mount, unmount, tick, onDestroy, untrack } from "svelte";
  import { createLauncherMainPush, type MainPushState } from "../lib/launcherMainPush";
  import type { MainPushCandidate, MainPushInvoke, MainPushPanel } from "../lib/pluginMainPushProtocol";
  import type { FeatureAction } from "../lib/types";
  type Listen = <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
  let { query, fixed = false, filter = "", active, invoke, listen, onupdate, onactivate, onclose, onescape, onredirect, onsettingsredirect }:
    { query: string; fixed?: boolean; filter?: string; active: boolean; invoke: MainPushInvoke; listen: Listen;
      onupdate: (state: MainPushState) => void;
      onactivate: (candidate: MainPushCandidate, query: string, commit: (action: FeatureAction) => void,
        isCurrent: () => boolean, closeSelectedRunner: () => Promise<void>) => Promise<void>;
      onclose: () => void | Promise<void>; onescape: () => void | Promise<void>;
      onredirect: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
      onsettingsredirect: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
    } = $props();
  let views = $state<Array<{ id: string; promoted: boolean }>>([]);
  let composing = $state(false);
  const nodes = new Map<string, HTMLDivElement>();
  const engine = untrack(() => createLauncherMainPush({ invoke, listen, changed: state => onupdate(state), activate: (...args) => onactivate(...args),
    promoted: id => { for (const view of views) view.promoted = view.id === id; },
    async createRunner(runner, waiting) {
      views = [...views, { id: runner.id, promoted: false }];
      await tick();
      const target = nodes.get(runner.id);
      if (!target?.isConnected) throw Error("ERR_MAIN_PUSH_MOUNT");
      const module = await import("./PluginPanel.svelte");
      if (!target.isConnected) throw Error("ERR_MAIN_PUSH_MOUNT");
      let ready!: () => void, fail!: (error: unknown) => void;
      const loaded = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      void loaded.catch(() => undefined);
      const instance = mount(module.default, { target, props: { action: runner.action, mainPushRunnerId: runner.id,
        onmainpushwaiting: waiting, onclose, onescape, onredirect, onsettingsredirect, onready: ready, onloaderror: fail } });
      const panel = instance as unknown as MainPushPanel;
      let closure: Promise<void> | undefined, strictClosed = false, unmounted = false;
      // MainPush binding is reset during the panel's first effect, before reading readiness.
      await tick();
      return { panel, ready: loaded.then(() => panel.mainPushReady()), resolveIcon: value => panel.mainPushResolveIcon(value),
        close(options?: { retry?: boolean }) {
          if (closure) return closure;
          const operation = (async () => {
            let failure: unknown, failed = false;
            if (!strictClosed) {
              try {
                if (options?.retry) await panel.closePersistentStrict({ retry: true });
                else await panel.closePersistentStrict();
                strictClosed = true;
              } catch (error) { failed = true; failure = error; }
            }
            if (!unmounted) {
              try { await unmount(instance); unmounted = true; views = views.filter(view => view.id !== runner.id); }
              catch (error) { if (!failed) failure = error; failed = true; }
            }
            if (failed) throw failure;
          })();
          closure = operation;
          void operation.then(() => { if (closure === operation) closure = undefined; }, () => { if (closure === operation) closure = undefined; });
          return operation;
        } };
    },
  }));
  function node(node: HTMLDivElement, id: string) { nodes.set(id, node); return { destroy() { nodes.delete(id); } }; }
  $effect(() => { const context = { query, fixed, filter, active, composing }; untrack(() => engine.update(context)); });
  onDestroy(() => { void engine.close().catch(() => { console.error("ERR_MAIN_PUSH_CLEANUP"); }); });
  export function select(code: string) { return engine.select(code); }
  export function owns(code: string) { return engine.owns(code); }
  export function enterGroup(group: string) { return engine.enterGroup(group); }
  export function requestEscape() { return engine.activePanel()?.requestEscape(); }
  export function closePromoted() { return engine.closePromoted(); }
  export function releaseForForeground(selectedRunnerId?: string) { return engine.releaseForForeground(selectedRunnerId); }
  export function retryCleanup(runnerId: string) { return engine.retryCleanup(runnerId); }
  export function retainedRuntimes() { return engine.retainedRuntimes(); }
</script>

<svelte:window oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} />
<div class="main-push-runners" class:promoted={views.some(view => view.promoted)} aria-label="插件搜索运行环境">
  {#each views as view (view.id)}
    <div class="main-push-runner" class:promoted={view.promoted} data-main-push-runner={view.id} use:node={view.id}></div>
  {/each}
</div>

<style>
  .main-push-runners { position: absolute; inset: 72px 0 0; pointer-events: none; z-index: 8; }
  .main-push-runner { position: absolute; inset: 0; pointer-events: none; }
  .main-push-runners.promoted { position: relative; inset: auto; height: 100%; min-height: 0; pointer-events: auto; }
  .main-push-runner.promoted { pointer-events: auto; }
</style>
