import { mount, tick, unmount } from "svelte";
import SearchStatusBar from "../../src/components/SearchStatusBar.svelte";

export const cases = {
  results: { mode: "results", count: 1200, selectedIndex: 16, selectedLabel: "分页命令 64", selectedAction: "执行", actionMenuAvailable: true },
  home: { mode: "home", count: 18, selectedIndex: 3, selectedLabel: "本地文件搜索", actionMenuAvailable: true },
  pinned: { mode: "home", count: 18, selectedIndex: 3, selectedLabel: "GitHub", titleOverride: "固定", detailOverride: "2 / 4 · GitHub", actionMenuAvailable: true },
  empty: { mode: "results", count: 0, selectedIndex: 0, selectedLabel: "" },
  target: { mode: "results", count: 300, selectedIndex: 299, selectedLabel: "很长的本地工具名称，供布局验收使用", selectedAction: "复制", tabAction: "target", tabTargetHint: "交给 很长的字符转换工具名称".repeat(4), actionMenuAvailable: true },
  feedback: { mode: "results", count: 300, selectedIndex: 0, selectedLabel: "原始文本", tabAction: "target", tabTargetHint: "设置目标", tabTargetFeedback: "尚未设置 Tab 目标，请选择一个本地指令", actionMenuAvailable: true },
} as const;
let instance: ReturnType<typeof mount> | undefined;
export let settingsClicks = 0;
export async function show(name: keyof typeof cases, width: number) {
  if (instance) await unmount(instance);
  const host = document.getElementById("status-fixture")!;
  host.style.width = width + "px";
  instance = mount(SearchStatusBar, { target: host, props: { ...cases[name], ontargetsettings: () => { settingsClicks += 1; } } });
  await tick();
}
