<script lang="ts">
  import type { SettingsSaveDebouncer } from "../../src/lib/settings";
  import { registerSettingsSaveFlushOnDestroy } from "../../src/lib/settingsLifecycle";

  let { debouncer }: { debouncer: Pick<SettingsSaveDebouncer, "flush"> } = $props();
  registerSettingsSaveFlushOnDestroy({ flush: () => debouncer.flush() });
</script>

<div data-testid="settings-lifecycle-harness">mounted</div>
