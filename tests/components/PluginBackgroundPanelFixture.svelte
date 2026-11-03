<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeatureAction } from "../../src/lib/types";

  type Props = {
    action: FeatureAction;
    persistentSessionId?: string;
    persistentVisible?: boolean;
    onclose?: (isKill?: boolean) => void | Promise<void>;
    onready?: () => void | Promise<void>;
    onloaderror?: (error: unknown) => void | Promise<void>;
    onbackgroundwaiting?: (waiting: boolean) => void;
  };
  let { action, persistentSessionId, persistentVisible = true, onclose, onready, onloaderror, onbackgroundwaiting }: Props = $props();
  let visible = $state(untrack(() => persistentVisible));
  let failNextStrictClose = false;
  const emit = (type: string, detail: unknown) => window.dispatchEvent(new CustomEvent(type, { detail }));

  onMount(() => {
    emit("fixture-background-panel-mounted", { pluginId: action.plugin_id, sessionId: persistentSessionId ?? null,
      setWaiting: (waiting: boolean) => onbackgroundwaiting?.(waiting),
      stop: () => onclose?.(true), failPanel: () => onloaderror?.(Error("ERR_FIXTURE_PANEL_FAILED")),
      failNextStrictClose: () => { failNextStrictClose = true; },
      ready: () => void Promise.resolve(onready?.()).then(() => emit("fixture-background-panel-ready", persistentSessionId ?? null)) });
  });

  export function activatePersistentEntry(next: FeatureAction) {
    setPersistentVisible(true);
    emit("fixture-background-panel-enter", next);
    return true;
  }
  export function setPersistentVisible(next: boolean) {
    visible = next;
    emit("fixture-background-panel-visible", { sessionId: persistentSessionId ?? null, visible: next });
  }
  export async function closePersistentStrict(options?: { retry?: boolean }) {
    const retry = options?.retry === true;
    emit("fixture-background-panel-strict-close", { sessionId: persistentSessionId ?? null, retry });
    if (failNextStrictClose && !retry) throw Error("ERR_FIXTURE_CLOSE_ON_FIRST_ATTEMPT");
    if (retry) failNextStrictClose = false;
  }
</script>

<section data-fixture-plugin={action.plugin_id} data-visible={visible}>
  {action.plugin_name}
</section>
