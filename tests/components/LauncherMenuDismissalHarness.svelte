<script lang="ts">
  import LauncherActionMenu from "../../src/components/LauncherActionMenu.svelte";
  import SearchBar from "../../src/components/SearchBar.svelte";
  import type { SearchResult } from "../../src/lib/types";
  type Props = { enabled?: boolean; onrestore?: () => void; onremove?: () => void };
  let { enabled = true, onrestore = () => {}, onremove = () => {} }: Props = $props();
  let query = $state("保留搜索词");
  let focusToken = $state(0);
  let actions: LauncherActionMenu | undefined;
  const item = { code: "convert", label: "字符转换", source: "history" as const };
  const command: SearchResult = { code: item.code, label: item.label, plugin_id: "converter",
    plugin_name: "转换插件", explain: "", icon: null, score: 1, match_type: "exact" };
  function restore() { onrestore(); focusToken += 1; }
</script>

<SearchBar {query} onchange={(value) => query = value} {focusToken} resultsId="dismissal-results" />
<div id="dismissal-results"></div>
<button oncontextmenu={(event) => actions?.open(event, item)}>操作目标</button>
<div data-testid="blank">空白区域</div>
<button>外部按钮</button>
<input id="other-input" aria-label="外部输入" />
<label for="other-input">外部输入标签</label>
<textarea aria-label="其他编辑器"></textarea>
<div role="textbox" aria-label="富文本编辑器" contenteditable="true" tabindex="0"></div>
<button disabled>禁用按钮</button>
<LauncherActionMenu bind:this={actions} {enabled} generation={query} pinnedCodes={[]}
  resolve={() => command} {onremove} onreturnfocus={restore} />
