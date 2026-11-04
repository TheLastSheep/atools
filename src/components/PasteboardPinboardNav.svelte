<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { PasteboardPinboard } from "../lib/pasteboard";

  interface Props {
    pinboards: PasteboardPinboard[];
    activePinboardId: string;
    onactivate: (id: string) => void | Promise<void>;
    onreloadpinboards: () => void | Promise<void>;
    onreloadall: (deletedId: string) => void | Promise<void>;
    onmoveselection: (pinboardId: string | null) => void | Promise<void>;
  }

  let {
    pinboards,
    activePinboardId,
    onactivate,
    onreloadpinboards,
    onreloadall,
    onmoveselection,
  }: Props = $props();

  let groupMenuId = $state("");
  let renameGroupId = $state("");
  let renameGroupName = $state("");
  let deleteGroupId = $state("");
  let newGroupOpen = $state(false);
  let newGroupName = $state("");

  async function createPinboard() {
    const name = newGroupName.trim();
    if (!name) return;
    await invoke("pasteboard_save_pinboard", { id: null, name, color: "#7C5CFF", orderKey: null });
    newGroupName = "";
    newGroupOpen = false;
    await onreloadpinboards();
  }

  function beginRenamePinboard(pinboard: PasteboardPinboard) {
    renameGroupId = pinboard.id;
    renameGroupName = pinboard.name;
  }

  async function renamePinboard(pinboard: PasteboardPinboard) {
    const name = renameGroupName.trim();
    if (!name || name === pinboard.name) return;
    await invoke("pasteboard_save_pinboard", {
      id: pinboard.id,
      name,
      color: pinboard.color,
      orderKey: pinboard.orderKey,
    });
    renameGroupId = "";
    renameGroupName = "";
    groupMenuId = "";
    await onreloadpinboards();
  }

  async function deletePinboard(pinboard: PasteboardPinboard) {
    await invoke("pasteboard_delete_pinboard", { id: pinboard.id });
    deleteGroupId = "";
    groupMenuId = "";
    await onreloadall(pinboard.id);
  }
</script>

<nav class="pinboards" aria-label="分组">
  <button class:active={!activePinboardId} onclick={() => onactivate("")}>全部</button>
  {#each pinboards as pinboard}
    <div class="pinboard-item">
      <button class:active={activePinboardId === pinboard.id} onclick={() => onactivate(pinboard.id)}>
        <i style={`--group-color:${pinboard.color}`}></i>{pinboard.name}
      </button>
      <button class="more" aria-label={`${pinboard.name}更多操作`} onclick={() => groupMenuId = groupMenuId === pinboard.id ? "" : pinboard.id}>•••</button>
      {#if groupMenuId === pinboard.id}
        <div class="group-menu">
          {#if renameGroupId === pinboard.id}
            <form class="rename-group" onsubmit={(event) => { event.preventDefault(); void renamePinboard(pinboard); }}>
              <input bind:value={renameGroupName} aria-label="新的分组名称" />
              <div><button type="submit" disabled={!renameGroupName.trim()}>保存</button><button type="button" onclick={() => { renameGroupId = ""; renameGroupName = ""; }}>取消</button></div>
            </form>
          {:else if deleteGroupId === pinboard.id}
            <div class="delete-group"><p>删除后内容会回到全部历史。</p><div><button class="danger" onclick={() => deletePinboard(pinboard)}>确认删除</button><button onclick={() => deleteGroupId = ""}>取消</button></div></div>
          {:else}
            <button onclick={() => beginRenamePinboard(pinboard)}>重命名分组</button>
            <button onclick={() => onmoveselection(pinboard.id)}>移入所选内容</button>
            <button class="danger" onclick={() => deleteGroupId = pinboard.id}>删除分组</button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if newGroupOpen}
    <form class="new-group" onsubmit={(event) => { event.preventDefault(); void createPinboard(); }}>
      <input bind:value={newGroupName} placeholder="分组名称" />
      <button type="submit">创建</button>
    </form>
  {:else}
    <button class="add-group" onclick={() => newGroupOpen = true}>＋ 新建分组</button>
  {/if}
</nav>
