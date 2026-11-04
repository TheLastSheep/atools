import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, PrimaryColor, WindowPositionStrategy } from "./settings";
import type { InstalledPlugin } from "./types";
import {
  settingsMenuItems,
  type SettingsIconName,
  type SettingsMenuId,
} from "./settingsPages";

export type MenuId = SettingsMenuId;
export type IconName = SettingsIconName;

export type Option<T extends string | number> = {
  label: string;
  value: T;
};

export type AccessibilityPermissionStatus = {
  supported: boolean;
  trusted: boolean;
  settingsUrl?: string | null;
};

export type SettingsConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "default" | "danger";
  resolve: (confirmed: boolean) => void;
};

export type PluginDocument = {
  _id: string;
  [key: string]: unknown;
};

export type PluginDataSummary = {
  plugin: InstalledPlugin;
  documents: number;
  error?: string;
};

export type DevtoolsOpenResult = {
  window_label: string;
  mode: string;
  detail: string;
};

export const menuItems = settingsMenuItems();
export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_KEEP_LATEST = 1000;

export const themeOptions: Option<string>[] = [
  { label: "跟随系统", value: "system" },
  { label: "明亮", value: "light" },
  { label: "暗黑", value: "dark" },
];

export const aiProviderOptions: Option<AiProvider>[] = [
  { label: "关闭", value: "disabled" },
  { label: "OpenAI", value: "openai" },
  { label: "兼容 API", value: "compatible" },
  { label: "本地模型", value: "local" },
];

export const autoPasteOptions: Option<string>[] = [
  { label: "关闭", value: "off" },
  { label: "1秒内", value: "1s" },
  { label: "3秒内", value: "3s" },
  { label: "5秒内", value: "5s" },
  { label: "10秒内", value: "10s" },
];

export const autoClearOptions: Option<string>[] = [
  { label: "立即", value: "immediately" },
  { label: "1分钟", value: "1m" },
  { label: "2分钟", value: "2m" },
  { label: "3分钟", value: "3m" },
  { label: "5分钟", value: "5m" },
  { label: "10分钟", value: "10m" },
  { label: "从不", value: "never" },
];

export const autoBackToSearchOptions: Option<string>[] = [
  { label: "立即", value: "immediately" },
  { label: "30秒", value: "30s" },
  { label: "1分钟", value: "1m" },
  { label: "3分钟", value: "3m" },
  { label: "5分钟", value: "5m" },
  { label: "10分钟", value: "10m" },
  { label: "从不", value: "never" },
];

export const windowPositionStrategyOptions: Option<WindowPositionStrategy>[] = [
  { label: "记住各屏位置", value: "remember" },
  { label: "鼠标屏居中", value: "cursor" },
  { label: "主屏居中", value: "primary" },
  { label: "上次使用屏居中", value: "lastActive" },
];

export const rowOptions: Option<number>[] = [
  { label: "1行", value: 1 },
  { label: "2行", value: 2 },
  { label: "3行", value: 3 },
  { label: "4行", value: 4 },
];

export const searchModeOptions: Option<string>[] = [
  { label: "聚合模式", value: "aggregate" },
  { label: "列表模式", value: "list" },
];

export const tabKeyOptions: Option<string>[] = [
  { label: "切换选中", value: "navigate" },
  { label: "目标指令", value: "target-command" },
];

export const devToolsModeOptions: Option<string>[] = [
  { label: "独立窗口", value: "detach" },
  { label: "靠右", value: "right" },
  { label: "靠下", value: "bottom" },
  { label: "独立窗口（可停靠）", value: "undocked" },
];

export const windowMaterialOptions: Option<string>[] = [
  { label: "无", value: "none" },
  { label: "Mica（云母）", value: "mica" },
  { label: "Acrylic（亚克力）", value: "acrylic" },
];

export const themeColors: Array<{ label: string; value: PrimaryColor; hex: string }> = [
  { label: "天空蓝", value: "blue", hex: "#0284c7" },
  { label: "罗兰紫", value: "purple", hex: "#7c3aed" },
  { label: "翡翠绿", value: "green", hex: "#059669" },
  { label: "活力橙", value: "orange", hex: "#ea580c" },
  { label: "宝石红", value: "red", hex: "#dc2626" },
  { label: "桃粉", value: "pink", hex: "#db2777" },
];

export const placeholderPages: Partial<Record<MenuId, Array<{ title: string; desc: string; meta: string }>>> = {
  shortcuts: [
    { title: "全局快捷键", desc: "为常用指令配置跨应用呼出快捷键", meta: "Option+Z" },
    { title: "应用快捷键", desc: "仅在主搜索界面生效的快捷键映射", meta: "Cmd+F / Cmd+Q" },
    { title: "别名映射", desc: "把短词映射到插件指令或本地应用", meta: "alias" },
  ],
  ai: [
    { title: "模型提供商", desc: "配置 OpenAI、兼容 API 或本地模型", meta: "provider" },
    { title: "默认模型", desc: "为 Agent 和 AI 插件指定默认模型", meta: "model" },
  ],
  mcp: [
    { title: "本地 MCP Server", desc: "绑定 127.0.0.1，通过 token 授权访问", meta: "127.0.0.1" },
    { title: "工具暴露", desc: "选择哪些插件工具可以被 MCP 客户端调用", meta: "tools" },
    { title: "调用审计", desc: "记录客户端、工具名、输入输出和确认结果", meta: "audit" },
  ],
  web: [
    { title: "搜索引擎", desc: "管理 Baidu、Bing、Google 和自定义快开", meta: "engine" },
    { title: "URL 模板", desc: "用 {query} 拼接网页搜索或站内搜索", meta: "template" },
  ],
  data: [
    { title: "插件数据", desc: "查看、导出或清空插件本地数据", meta: "db" },
    { title: "剪贴板历史", desc: "配置历史保留天数并支持本地检索", meta: "180天" },
  ],
  commands: [
    { title: "全部指令", desc: "查看插件命令、系统命令和文件匹配命令", meta: "commands" },
    { title: "固定到搜索框", desc: "把高频命令固定到主搜索面板", meta: "pin" },
  ],
  local: [
    { title: "本地启动项", desc: "把文件、文件夹和应用固定为可搜索指令", meta: "local" },
    { title: "路径校验", desc: "检查不存在或已移动的本地启动项", meta: "scan" },
  ],
  sync: [
    { title: "WebDAV 配置", desc: "同步插件、设置和命令数据", meta: "webdav" },
    { title: "同步策略", desc: "选择覆盖、本地优先或远端优先", meta: "strategy" },
  ],
  debug: [
    { title: "调试日志", desc: "查看主进程、插件和 MCP 服务日志", meta: "logs" },
    { title: "开发者工具", desc: "控制插件 DevTools 默认打开位置", meta: "detach" },
  ],
};

export const iconMarkup: Record<IconName, string> = {
  settings: '<path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.03 4.2l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.56.78.96 1.56.96H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  keyboard: '<path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  plugin: '<path d="M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0V7Z"/><path d="M12 17v4M8 21h8"/>',
  store: '<path d="M5 10h14l-1 10H6L5 10Z"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M5 10 3 6h18l-2 4"/>',
  brain: '<path d="M8.5 14.5A3.5 3.5 0 0 1 5 11V9.5A3.5 3.5 0 0 1 8.5 6 3.5 3.5 0 0 1 12 2.5 3.5 3.5 0 0 1 15.5 6 3.5 3.5 0 0 1 19 9.5V11a3.5 3.5 0 0 1-3.5 3.5"/><path d="M12 2.5V21M8.5 14.5A3.5 3.5 0 0 0 12 18a3.5 3.5 0 0 0 3.5-3.5"/>',
  mcp: '<path d="M12 3v6M12 15v6M5.2 7.5l5.2 3M13.6 13l5.2 3M18.8 7.5l-5.2 3M10.4 13l-5.2 3"/><path d="M12 9.3 16 12l-4 2.7L8 12l4-2.7Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.5-4.5"/>',
  database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.66 3.13 3 7 3s7-1.34 7-3V5"/><path d="M5 12v7c0 1.66 3.13 3 7 3s7-1.34 7-3v-7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  cloud: '<path d="M17.5 18H8a5 5 0 1 1 1.2-9.85A6 6 0 0 1 20 12.5 3.5 3.5 0 0 1 17.5 18Z"/>',
  terminal: '<path d="m4 7 5 5-5 5M11 17h9"/><path d="M3 4h18v16H3z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

export function iconFor(name: IconName) {
  return iconMarkup[name];
}

export function hasTauriRuntime() {
  const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof runtime?.invoke === "function";
}

export async function callHumanCapability(name: string, arguments_: Record<string, unknown>) {
  return invoke("call_agent_tool", {
    name,
    arguments: arguments_,
    clientId: "atools-ui",
    confirmed: true,
  });
}

export async function copyText(text: string) {
  if (hasTauriRuntime()) {
    await invoke("copy_text", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function safeHomePath() {
  try {
    return await invoke<string>("system_get_path", { name: "home" });
  } catch {
    return "";
  }
}
