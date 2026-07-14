export type SearchStatusBarMode = "home" | "results";
export type SearchStatusBarTabAction = "select" | "target";

export type SearchStatusBarHint = {
  key: string;
  label: string;
};

export type SearchStatusBarView = {
  title: string;
  detail: string;
  hints: SearchStatusBarHint[];
};

export type SearchStatusBarInput = {
  mode: SearchStatusBarMode;
  count: number;
  selectedIndex: number;
  selectedLabel: string;
  selectedAction?: string;
  titleOverride?: string;
  detailOverride?: string;
  tabAction: SearchStatusBarTabAction;
};

export function searchStatusBarView(input: SearchStatusBarInput): SearchStatusBarView {
  const count = Math.max(0, input.count);
  const selectedPosition = count > 0 ? Math.max(1, Math.min(count, input.selectedIndex + 1)) : 0;
  const selectedLabel = input.selectedLabel.trim();
  const selectedAction = input.selectedAction?.trim() || defaultActionFor(input.mode);
  const tabLabel = input.tabAction === "target" ? "执行" : "切换";

  if (input.mode === "home") {
    const titleOverride = input.titleOverride?.trim();
    const detailOverride = input.detailOverride?.trim();
    return {
      title: titleOverride || "最近使用",
      detail: detailOverride || (count > 0 ? `${selectedPosition} / ${count}${selectedLabel ? ` · ${selectedLabel}` : ""}` : "0 项最近使用"),
      hints: [
        { key: "↑↓←→", label: "移动" },
        { key: "Enter", label: "打开" },
        { key: "Tab", label: tabLabel },
        { key: "Esc", label: "收起" },
      ],
    };
  }

  if (count === 0) {
    return {
      title: "搜索结果",
      detail: "0 项匹配",
      hints: [
        { key: "Enter", label: "执行首项" },
        { key: "Tab", label: tabLabel },
        { key: "Esc", label: "清空" },
      ],
    };
  }

  return {
    title: "搜索结果",
    detail: `${selectedPosition} / ${count}${selectedLabel ? ` · ${selectedLabel}` : ""}`,
    hints: [
      { key: "↑", label: "上一行" },
      { key: "↓", label: "下一行" },
      { key: "Enter", label: selectedAction },
      { key: "Tab", label: tabLabel },
      { key: "Esc", label: "清空" },
    ],
  };
}

function defaultActionFor(mode: SearchStatusBarMode) {
  return mode === "home" ? "打开" : "执行";
}
