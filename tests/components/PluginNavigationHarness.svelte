<script lang="ts">
  import type { ComponentProps } from "svelte";
  import PluginNavigationBar from "../../src/components/PluginNavigationBar.svelte";

  let { onrefchange, ...props }: ComponentProps<typeof PluginNavigationBar> & {
    onrefchange: (input: HTMLInputElement | null | undefined) => void;
  } = $props();
  let inputRef = $state<HTMLInputElement | null>();
  $effect(() => { onrefchange(inputRef); });
</script>

<PluginNavigationBar {...props} bind:inputRef />
