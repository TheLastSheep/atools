export type ShellPanel = "home" | "settings" | "plugins" | "import" | "agent";

export const SYSTEM_ACTIONS: Array<{ id: ShellPanel; label: string; description: string; aliases?: string[] }> = [
  { id: "settings", label: "设置", description: "打开通用设置、快捷键、插件市场和本地服务", aliases: ["settings", "config", "preferences"] },
  { id: "plugins", label: "插件管理", description: "查看、启用、禁用已安装插件", aliases: ["plugins", "plugin"] },
  { id: "import", label: "导入 ZTools 插件", description: "扫描 plugin.json 并批量导入", aliases: ["import", "ztools"] },
  { id: "agent", label: "Agent / MCP", description: "管理工具、权限和审计", aliases: ["agent", "mcp"] },
];

export type RecommendedCommand = {
  code: string;
  label: string;
  explain: string;
  panel?: ShellPanel;
  input?: string;
  source?: "history" | "recommended" | "pinned";
};

export const RECOMMENDED_COMMANDS: RecommendedCommand[] = [
  { code: "图片批处理", label: "图片批处理", explain: "批量压缩、转换和处理图片" },
  { code: "ip", label: "ip", explain: "查看本机 IP 信息" },
  { code: "hosts", label: "hosts", explain: "管理 hosts" },
  { code: "设置", label: "设置", explain: "打开工具设置", panel: "settings" },
  { code: "上次匹配", label: "上次匹配", explain: "恢复上次命令匹配" },
  { code: "OCR", label: "OCR", explain: "图片文字识别" },
  { code: "ctool", label: "ctool", explain: "开发常用工具" },
  { code: "结束进程", label: "结束进程", explain: "结束本地进程" },
  { code: "计算稿纸", label: "计算稿纸", explain: "快速计算草稿" },
  { code: "curl", label: "curl", explain: "curl 命令工具" },
  { code: "ToDo 待办", label: "ToDo 待办", explain: "待办事项" },
];
