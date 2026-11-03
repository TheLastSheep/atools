<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import PluginBackgroundSessionHost from "../../src/components/PluginBackgroundSessionHost.svelte";
  import { providePluginRuntimeControl, type PluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";

  type Props = {
    control: PluginRuntimeControl;
    hostProps: ComponentProps<typeof PluginBackgroundSessionHost>;
  };
  let { control, hostProps }: Props = $props();
  providePluginRuntimeControl(untrack(() => control));
</script>

<PluginBackgroundSessionHost {...hostProps} />
