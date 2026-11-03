<script lang="ts">
  import HomePanel from "../../src/components/HomePanel.svelte";
  import type { RecommendedCommand } from "../../src/lib/uiState";

  let commands = $state<RecommendedCommand[]>([
    { code: "alpha", label: "Alpha", explain: "Alpha purpose", source: "history" },
    { code: "beta", label: "Beta", explain: "Beta purpose", source: "history" },
  ]);
  let selectedIndex = $state(0);
  let refreshCount = $state(0);

  function refreshCommands(index: number) {
    selectedIndex = index;
    commands = commands.map((command) => ({ ...command }));
    refreshCount += 1;
  }
</script>

<HomePanel
  {commands}
  {selectedIndex}
  oncommand={() => {}}
  onpanelchange={() => {}}
  onselectionchange={refreshCommands}
/>
<output data-testid="command-refresh-count">{refreshCount}</output>
