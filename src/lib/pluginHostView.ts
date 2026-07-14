import type { FeatureAction, PluginItem } from "./types";
import { pluginBridgeRuntimeDetail } from "./pluginBridgeCapabilities";

export type PluginHostBodyMode = "loading" | "error" | "iframe" | "output";

export type PluginHostAction = {
  id: "back" | "settings" | "detach";
  label: string;
  available: boolean;
};

export type PluginHostOutputRow = PluginItem & {
  selected: boolean;
  actionHint: string;
};

export type PluginHostRuntimeChip = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "normal" | "warning" | "error" | "muted";
};

export type PluginHostContextMenuState = {
  target: string;
};

export type PluginHostView = {
  chrome: {
    title: string;
    feature: string;
    source: string;
  };
  actions: PluginHostAction[];
  layoutSlots: Array<"titlebar" | "runtime" | "subinput" | "body">;
  bodyMode: PluginHostBodyMode;
  iframeClass: string;
  outputLayerClass: string;
  runtimeChips: PluginHostRuntimeChip[];
  outputRows: PluginHostOutputRow[];
  loadError: string;
};

export function pluginHostView(
  action: FeatureAction,
  state: {
    subInputVisible: boolean;
    iframeReady: boolean;
    outputItems: PluginItem[];
    selectedIndex: number;
    loadError?: string | null;
    dynamicFeatureCount?: number;
    registeredToolCount?: number;
    requestedHeight?: number;
    contextMenuTarget?: string;
    browserWindowCount?: number;
    browserWindowMessage?: string;
    uiHostProbePassed?: number;
    uiHostProbeTotal?: number;
    uiHostProbeFailedIds?: string[];
  },
): PluginHostView {
  const loadError = state.loadError || "";
  const bodyMode = pluginHostBodyMode({
    loadError,
    iframeReady: state.iframeReady,
    outputCount: state.outputItems.length,
  });
  return {
    chrome: {
      title: action.plugin_name || action.plugin_id,
      feature: action.feature_code,
      source: action.plugin_id,
    },
    actions: [
      { id: "back", label: "返回", available: true },
      { id: "settings", label: "设置", available: false },
      { id: "detach", label: "分离", available: true },
    ],
    layoutSlots: state.subInputVisible ? ["titlebar", "runtime", "subinput", "body"] : ["titlebar", "runtime", "body"],
    bodyMode,
    iframeClass: "plugin-iframe full-bleed",
    outputLayerClass: "plugin-output-layer",
    runtimeChips: pluginHostRuntimeChips({
      bodyMode,
      subInputVisible: state.subInputVisible,
      outputCount: state.outputItems.length,
      dynamicFeatureCount: state.dynamicFeatureCount ?? 0,
      registeredToolCount: state.registeredToolCount ?? 0,
      requestedHeight: normalizePluginRequestedHeight(state.requestedHeight),
      contextMenuTarget: state.contextMenuTarget || "",
      browserWindowCount: state.browserWindowCount ?? 0,
      browserWindowMessage: state.browserWindowMessage || "",
      uiHostProbePassed: state.uiHostProbePassed ?? 0,
      uiHostProbeTotal: state.uiHostProbeTotal ?? 0,
      uiHostProbeFailedIds: state.uiHostProbeFailedIds ?? [],
    }),
    outputRows: state.outputItems.map((item, index) => ({
      ...item,
      selected: index === state.selectedIndex,
      actionHint: index === state.selectedIndex ? "Enter 复制" : "",
    })),
    loadError,
  };
}

function pluginHostRuntimeChips(state: {
  bodyMode: PluginHostBodyMode;
  subInputVisible: boolean;
  outputCount: number;
  dynamicFeatureCount: number;
  registeredToolCount: number;
  requestedHeight: number;
  contextMenuTarget: string;
  browserWindowCount: number;
  browserWindowMessage: string;
  uiHostProbePassed: number;
  uiHostProbeTotal: number;
  uiHostProbeFailedIds: string[];
}): PluginHostRuntimeChip[] {
  const chips: PluginHostRuntimeChip[] = [
    runtimeModeChip(state.bodyMode),
    {
      label: "SubInput",
      value: state.subInputVisible ? "已启用" : "未启用",
      detail: state.subInputVisible ? "插件请求了关键字输入" : "插件未请求输入框",
      tone: state.subInputVisible ? "ready" : "muted",
    },
    {
      label: "输出结果",
      value: `${state.outputCount} 项`,
      detail: state.outputCount > 0 ? "方向键选择，Enter 复制" : "等待插件调用 outPlugin",
      tone: state.outputCount > 0 ? "ready" : "muted",
    },
    {
      label: "桥接能力",
      value: "utools/ztools",
      detail: pluginBridgeRuntimeDetail(),
      tone: "normal",
    },
  ];
  if (state.requestedHeight > 0) {
    chips.push({
      label: "动态高度",
      value: `${state.requestedHeight} px`,
      detail: "插件请求的运行视图高度",
      tone: "ready",
    });
  }
  if (state.dynamicFeatureCount > 0) {
    chips.push({
      label: "动态指令",
      value: `${state.dynamicFeatureCount} 项`,
      detail: "插件运行时注册的临时 feature",
      tone: "ready",
    });
  }
  if (state.registeredToolCount > 0) {
    chips.push({
      label: "注册工具",
      value: `${state.registeredToolCount} 项`,
      detail: "插件运行时注册的工具处理器",
      tone: "ready",
    });
  }
  if (state.contextMenuTarget) {
    chips.push({
      label: "右键菜单",
      value: state.contextMenuTarget,
      detail: "iframe 已上报 contextmenu，宿主保留插件自定义事件路径",
      tone: "ready",
    });
  }
  if (state.browserWindowCount > 0) {
    chips.push({
      label: "Browser 窗口",
      value: `${state.browserWindowCount} 个`,
      detail: state.browserWindowMessage
        ? `最近消息 ${state.browserWindowMessage}`
        : "宿主内子 iframe 已创建，可接收 sendToParent",
      tone: "ready",
    });
  }
  const probeChip = uiHostProbeChip(state.uiHostProbePassed, state.uiHostProbeTotal, state.uiHostProbeFailedIds);
  if (probeChip) chips.push(probeChip);
  return chips;
}

function uiHostProbeChip(
  rawPassed: number,
  rawTotal: number,
  failedIds: string[],
): PluginHostRuntimeChip | null {
  const total = Math.max(0, Math.round(rawTotal));
  if (total <= 0) return null;
  const passed = Math.max(0, Math.min(total, Math.round(rawPassed)));
  const failed = total - passed;
  return {
    label: "宿主探针",
    value: `${passed}/${total}`,
    detail: failed === 0
      ? "iframe 已回传 bridge/lifecycle 探针"
      : `失败 ${failed} 项: ${failedIds.slice(0, 3).join(", ") || "unknown"}`,
    tone: failed === 0 ? "ready" : "warning",
  };
}

function normalizePluginRequestedHeight(value: unknown): number {
  if (value == null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(120, Math.min(900, Math.round(numeric)));
}

export function normalizePluginOutputItems(value: unknown): PluginItem[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] && typeof value[0] === "object" && Array.isArray((value[0] as { items?: unknown }).items)) {
      return normalizePluginOutputItems((value[0] as { items: unknown }).items);
    }
    return value.map(normalizePluginItem).filter((item): item is PluginItem => item !== null);
  }
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return normalizePluginOutputItems((value as { items: unknown }).items);
  }
  const single = normalizePluginItem(value);
  return single ? [single] : [];
}

function runtimeModeChip(bodyMode: PluginHostBodyMode): PluginHostRuntimeChip {
  if (bodyMode === "error") {
    return {
      label: "运行状态",
      value: "加载失败",
      detail: "查看错误信息后返回重试",
      tone: "error",
    };
  }
  if (bodyMode === "output") {
    return {
      label: "运行状态",
      value: "输出层",
      detail: "插件已返回可选结果",
      tone: "ready",
    };
  }
  if (bodyMode === "iframe") {
    return {
      label: "运行状态",
      value: "iframe",
      detail: "插件页面已载入",
      tone: "ready",
    };
  }
  return {
    label: "运行状态",
    value: "加载中",
    detail: "正在注入桥接脚本",
    tone: "warning",
  };
}

function pluginHostBodyMode(state: {
  loadError: string;
  iframeReady: boolean;
  outputCount: number;
}): PluginHostBodyMode {
  if (state.loadError) return "error";
  if (state.outputCount > 0) return "output";
  if (state.iframeReady) return "iframe";
  return "loading";
}

function normalizePluginItem(value: unknown): PluginItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.title == null) return null;
  const item: PluginItem = {
    title: String(record.title),
  };
  if (record.description != null) item.description = String(record.description);
  if (record.data != null) item.data = String(record.data);
  if (record.icon != null) item.icon = String(record.icon);
  return item;
}
