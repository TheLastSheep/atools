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
  icon?: string | null;
  panel?: ShellPanel;
  input?: string;
  source?: "history" | "recommended" | "pinned";
};

export const RECOMMENDED_COMMANDS: RecommendedCommand[] = [
  { code: "paste-clipboard", label: "Paste剪切板", explain: "本地剪贴板历史与分组" },
  { code: "ip", label: "IP 地址", explain: "查看本机 IP 信息" },
  { code: "process-manager", label: "结束进程", explain: "查看并结束本地进程" },
  { code: "http-client", label: "HTTP 请求", explain: "Rust 原生 HTTP 请求工具" },
  { code: "hosts", label: "Hosts 编辑器", explain: "读取并管理系统 hosts" },
  { code: "todo", label: "ToDo", explain: "本地待办事项" },
  { code: "calc", label: "计算稿纸", explain: "快速计算并保存历史" },
  { code: "codec", label: "编码转换", explain: "Base64、URL 与 Unicode 转换" },
  { code: "timestamp", label: "时间戳", explain: "时间戳与日期转换" },
  { code: "qr-code", label: "二维码", explain: "生成二维码图片" },
  { code: "json", label: "JSON 查看器", explain: "格式化、压缩和校验 JSON" },
  { code: "color-converter", label: "颜色转换", explain: "HEX、RGB 与 HSL 转换" },
  { code: "翻译", label: "翻译", explain: "Rust 原生多语言翻译" },
  { code: "设置", label: "设置", explain: "打开工具设置", panel: "settings" },
];
