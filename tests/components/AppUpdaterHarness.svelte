<script lang="ts">
  import AppUpdatePrompt from "../../src/components/AppUpdatePrompt.svelte";
  import type { AppUpdaterState } from "../../src/lib/appUpdater";

  type Props = {
    state: AppUpdaterState;
    ondismiss: () => void;
    oninstall: () => void | Promise<void>;
  };

  let { state, ondismiss, oninstall }: Props = $props();
</script>

<AppUpdatePrompt {state} {ondismiss} {oninstall} />
