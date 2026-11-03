<script lang="ts">
  import { onMount } from "svelte";
  import PermissionPromptHost from "../../src/components/PermissionPromptHost.svelte";
  import { createPermissionHarnessBackend } from "./permissionHarnessBackend";

  let { onready }: { onready: (backend: ReturnType<typeof createPermissionHarnessBackend>) => void } = $props();
  const backend = createPermissionHarnessBackend();
  onMount(() => { onready(backend); });
</script>

<main>
  <header><h1>插件授权</h1><p>真实授权弹窗与事件队列 · 浏览器模拟 IPC 验证</p></header>
  <label for="launcher-search">搜索命令</label>
  <input id="launcher-search" placeholder="搜索应用、插件或文件" />
  <section><h2>等待打开插件</h2><p>授权请求结束后，键盘焦点应回到这里。</p></section>
</main>
<PermissionPromptHost invoke={backend.invoke} listen={backend.listen} />

<style>
  main { width: 720px; max-width: calc(100vw - 48px); margin: 40px auto; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-primary); padding: 24px; color: var(--text-primary); }
  h1 { margin: 0; font-size: 20px; }
  p { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
  label { display: block; margin: 24px 0 8px; font-size: 12px; color: var(--text-secondary); }
  input { width: 100%; border: 1px solid var(--border-strong); border-radius: 8px; padding: 12px; background: var(--bg-secondary); color: var(--text-primary); }
  input:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
  section { margin-top: 24px; padding: 24px 0; border-top: 1px solid var(--border); }
  h2 { font-size: 15px; }
</style>
