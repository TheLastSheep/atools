<script lang="ts">
  import SearchBar from "../../src/components/SearchBar.svelte";

  type Props = { onchange: (query: string) => void };
  let { onchange }: Props = $props();
  let query = $state("");
</script>

<SearchBar
  {query}
  onchange={(value) => { query = value; onchange(value); }}
  resultsId="launcher-results"
  expanded={query.length > 0}
  activeDescendant={query ? "launcher-result-0" : undefined}
/>
