<script lang="ts">
  import { onMount } from "svelte";
  import ResultsList from "../../src/components/ResultsList.svelte";
  import type { SearchResult } from "../../src/lib/types";

  type Controller = {
    select: (index: number) => void;
    replace: (results: SearchResult[], query: string) => void;
  };
  type Props = {
    initialResults: SearchResult[];
    initialQuery: string;
    onready: (controller: Controller) => void;
    onactivate: (index: number) => void;
  };

  let { initialResults, initialQuery, onready, onactivate }: Props = $props();
  let results: SearchResult[] = $state([]);
  let selectedIndex = $state(0);
  let query = $state("");

  onMount(() => {
    results = initialResults;
    query = initialQuery;
    onready({
      select: (index) => { selectedIndex = index; },
      replace: (items, value) => { results = items; query = value; selectedIndex = 0; },
    });
  });
</script>

<ResultsList
  {results}
  {query}
  {selectedIndex}
  onselect={onactivate}
  onselectionchange={(index) => selectedIndex = index}
/>
