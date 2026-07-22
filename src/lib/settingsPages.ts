export type SettingsMenuId =
  | "general"
  | "shortcuts"
  | "plugins"
  | "market"
  | "providers"
  | "ai"
  | "mcp"
  | "web"
  | "data"
  | "commands"
  | "local"
  | "sync"
  | "debug"
  | "http"
  | "about";

export type SettingsIconName =
  | "settings"
  | "keyboard"
  | "plugin"
  | "store"
  | "brain"
  | "mcp"
  | "search"
  | "database"
  | "list"
  | "folder"
  | "cloud"
  | "terminal"
  | "monitor"
  | "info";

export type SettingsMenuItem = {
  id: SettingsMenuId;
  label: string;
  icon: SettingsIconName;
};

export type HotkeyPlatform = "mac" | "windows" | "linux";

export type HotkeyPreset = {
  label: string;
  value: string;
  description: string;
};

export type ShortcutTabId = "global" | "app" | "alias";

export type ShortcutTab = {
  id: ShortcutTabId;
  label: string;
  description: string;
};

export type BuiltInShortcutRow = {
  id: string;
  shortcut: string;
  target: string;
  scope: string;
  configurable: boolean;
};

export type AppShortcutEntry = {
  id: string;
  shortcut: string;
  targetCode: string;
  enabled: boolean;
};

export type AppShortcutTarget = {
  code: string;
  label: string;
  explain: string;
  enabled?: boolean;
};

export type AppShortcutRow = AppShortcutEntry & {
  targetLabel: string;
  targetDetail: string;
  statusLabel: string;
  conflictLabel: string;
};

export type CapabilityStatus = {
  id: string;
  label: string;
  description: string;
  status: string;
  available: boolean;
};

export type FactRow = {
  label: string;
  value: string;
};

export type AboutCard = {
  label: string;
  value: string;
  detail: string;
};

export type AboutOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "desktop" | "normal" | "private";
};

export type DataOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "desktop" | "private";
};

export type AuditRetentionPolicyRow = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "desktop" | "private" | "warning";
};

export type GeneralOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "warning" | "normal";
};

export type HttpServiceOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "warning" | "normal";
};

export type AiOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "disabled" | "desktop" | "private";
};

export type McpGovernanceCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "danger" | "desktop";
};

export type McpGovernanceTool = {
  enabled?: boolean;
  scopes?: string[];
};

export type McpGovernanceScopePolicy = {
  scope: string;
  label?: string;
  description?: string;
  decision: string;
  high_risk: boolean;
};

export type McpGovernanceOverview = {
  cards: McpGovernanceCard[];
  auditChain: string;
};

export type McpScopePolicyRow = McpGovernanceScopePolicy & {
  label: string;
  description: string;
  riskLabel: string;
  decisionLabel: string;
  blocked: boolean;
};

export type McpPendingRequestInput = {
  id: string;
  client_id: string;
  tool_name: string;
  arguments: unknown;
  scopes: string[];
  created_at: string;
};

export type McpPendingRequestRow = {
  id: string;
  toolName: string;
  clientId: string;
  scopeLabel: string;
  argumentPreview: string;
  createdAt: string;
  actions: ["允许一次", "允许并记住", "拒绝"];
};

export type McpGrantInput = {
  client_id: string;
  tool_name: string;
  created_at: string;
  updated_at: string;
};

export type McpGrantRow = {
  clientId: string;
  toolName: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type McpAuditInput = {
  id: string;
  timestamp: string;
  client_id: string;
  tool_name: string;
  input: unknown;
  output: unknown;
  status: string;
  duration_ms: number;
  error?: string | null;
};

export type McpAuditRow = {
  id: string;
  toolName: string;
  clientId: string;
  timestamp: string;
  statusLabel: string;
  tone: "success" | "denied" | "error" | "pending" | "unknown";
  durationLabel: string;
  preview: string;
};

export type ShortcutOverviewCard = {
  label: string;
  value: string;
  detail: string;
};

export type ShortcutPageOverview = {
  cards: ShortcutOverviewCard[];
  emptyStates: {
    global: string;
    app: string;
    alias: string;
  };
};

export type CommandCenterSourceId = "system" | "local" | "web" | "plugin";

export type CommandCenterStatusFilter = "all" | "enabled" | "disabled";

export type CommandCenterSourceFilter = "all" | CommandCenterSourceId;

export type CommandCenterTarget = {
  code: string;
  label: string;
  explain: string;
  source?: CommandCenterSourceId;
  enabled?: boolean;
};

export type CommandCenterAlias = {
  alias: string;
  targetCode: string;
  enabled?: boolean;
};

export type CommandCenterGroup = {
  id: CommandCenterSourceId;
  label: string;
  description: string;
  count: number;
  enabledCount: number;
  aliasCount: number;
};

export type CommandCenterOverview = {
  totalTargets: number;
  enabledTargets: number;
  aliasCount: number;
  enabledAliasCount: number;
  groups: CommandCenterGroup[];
};

export type CommandCenterRow = {
  code: string;
  label: string;
  explain: string;
  source: CommandCenterSourceId;
  sourceLabel: string;
  statusLabel: string;
  pinStatusLabel: string;
  pinLabel: string;
  enabled: boolean;
  pinned: boolean;
  aliases: string[];
  enabledAliases: string[];
  aliasLabel: string;
  aliasPreview: string[];
  aliasHint: string;
  aliasActionLabel: string;
};

export type CommandCenterRowsInput = {
  targets: CommandCenterTarget[];
  aliases: CommandCenterAlias[];
  source: CommandCenterSourceFilter;
  status: CommandCenterStatusFilter;
  query: string;
  pinnedCodes?: string[];
};

const COMMAND_CENTER_SOURCE_ORDER: CommandCenterSourceId[] = ["system", "local", "web", "plugin"];

export function settingsMenuItems(): SettingsMenuItem[] {
  return [
    { id: "general", label: "通用设置", icon: "settings" },
    { id: "shortcuts", label: "快捷键", icon: "keyboard" },
    { id: "plugins", label: "已安装插件", icon: "plugin" },
    { id: "market", label: "插件市场", icon: "store" },
    { id: "providers", label: "能力提供商", icon: "brain" },
    { id: "ai", label: "AI 模型", icon: "brain" },
    { id: "mcp", label: "MCP 服务", icon: "mcp" },
    { id: "web", label: "网页快开", icon: "search" },
    { id: "data", label: "我的数据", icon: "database" },
    { id: "commands", label: "所有指令", icon: "list" },
    { id: "local", label: "本地启动", icon: "folder" },
    { id: "sync", label: "WebDAV 同步", icon: "cloud" },
    { id: "debug", label: "调试日志", icon: "terminal" },
    { id: "http", label: "HTTP 服务", icon: "monitor" },
    { id: "about", label: "关于", icon: "info" },
  ];
}

export function defaultHotkeyForPlatform(platform: HotkeyPlatform | string): string {
  return platform === "mac" ? "Option+Z" : "Alt+Z";
}

export function hotkeyPresetsForPlatform(platform: HotkeyPlatform | string): HotkeyPreset[] {
  if (platform === "mac") {
    return [
      { label: "默认", value: "Option+Z", description: "ZTools macOS 默认呼出快捷键" },
      { label: "系统搜索习惯", value: "Command+Space", description: "接近 macOS Spotlight，但可能冲突" },
      { label: "输入法旁路", value: "Control+Space", description: "适合避开 Option 组合键" },
    ];
  }

  return [
    { label: "默认", value: "Alt+Z", description: "Windows/Linux 默认呼出快捷键" },
    { label: "搜索习惯", value: "Control+Space", description: "接近启动器常用组合键" },
    { label: "备用", value: "Alt+Space", description: "需确认不会与窗口菜单冲突" },
  ];
}

export function shortcutTabs(): ShortcutTab[] {
  return [
    { id: "global", label: "全局快捷键", description: "跨应用触发 ATools 或指定动作" },
    { id: "app", label: "应用快捷键", description: "仅在 ATools 主窗口激活时生效" },
    { id: "alias", label: "指令别名", description: "用短词映射系统命令、本地启动和网页快开" },
  ];
}

export function builtInAppShortcutsForPlatform(
  platform: HotkeyPlatform | string,
  options: { spaceOpenCommand: boolean; tabKeyFunction: string },
): BuiltInShortcutRow[] {
  const isMac = platform === "mac";
  const mod = isMac ? "Command" : "Ctrl";
  const devtools = isMac ? "Option+Command+I" : "Ctrl+Shift+I";
  return [
    {
      id: "builtin-detach",
      shortcut: `${mod}+D`,
      target: "分离插件到独立窗口",
      scope: "插件窗口",
      configurable: false,
    },
    {
      id: "builtin-search",
      shortcut: `${mod}+F`,
      target: "固定搜索框文本并进行二次筛选",
      scope: "主搜索/插件",
      configurable: false,
    },
    {
      id: "builtin-tab-target",
      shortcut: "Tab",
      target: options.tabKeyFunction === "target-command" ? "进入目标指令" : "切换选中项",
      scope: "主搜索",
      configurable: true,
    },
    {
      id: "builtin-settings",
      shortcut: `${mod}+,`,
      target: "打开设置",
      scope: "主窗口",
      configurable: false,
    },
    {
      id: "builtin-kill-plugin",
      shortcut: `${mod}+Q`,
      target: "终止当前插件运行",
      scope: "插件窗口",
      configurable: false,
    },
    {
      id: "builtin-close-plugin",
      shortcut: `${mod}+W`,
      target: "关闭插件或隐藏窗口",
      scope: "主窗口/插件",
      configurable: false,
    },
    {
      id: "builtin-devtools",
      shortcut: devtools,
      target: "打开或关闭开发者工具",
      scope: "开发调试",
      configurable: false,
    },
    {
      id: "builtin-space",
      shortcut: "Space",
      target: options.spaceOpenCommand ? "空搜索时打开选中指令" : "空搜索时不触发指令",
      scope: "主搜索",
      configurable: true,
    },
  ];
}

export function createAppShortcut(
  targetCode: string,
  existingShortcuts: string[] = [],
  platform: HotkeyPlatform | string = "mac",
  id = `app-shortcut-${Date.now().toString(36)}`,
): AppShortcutEntry {
  return {
    id,
    shortcut: nextAppShortcut(existingShortcuts, platform),
    targetCode,
    enabled: true,
  };
}

export function normalizeAppShortcuts(entries: unknown): AppShortcutEntry[] {
  if (!Array.isArray(entries)) return [];
  const normalized: AppShortcutEntry[] = [];
  let generatedIdCount = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<AppShortcutEntry>;
    const shortcut = typeof raw.shortcut === "string" ? raw.shortcut.trim() : "";
    const targetCode = typeof raw.targetCode === "string" ? raw.targetCode.trim() : "";
    if (!shortcut || !targetCode) continue;
    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!rawId) generatedIdCount += 1;
    normalized.push({
      id: rawId || `app-shortcut-${generatedIdCount}`,
      shortcut,
      targetCode,
      enabled: raw.enabled !== false,
    });
  }
  return normalized;
}

export function appShortcutRows(input: {
  entries: AppShortcutEntry[];
  targets: AppShortcutTarget[];
  builtIns: BuiltInShortcutRow[];
  platform: HotkeyPlatform | string;
}): AppShortcutRow[] {
  const entries = normalizeAppShortcuts(input.entries);
  const duplicateCounts = shortcutCounts(entries);
  const builtInShortcuts = new Set(input.builtIns.map((row) => normalizeShortcutKey(row.shortcut)));
  return entries.map((entry) => {
    const target = input.targets.find((item) => item.code === entry.targetCode);
    const validation = validateAppShortcut(entry.shortcut, normalizePlatform(input.platform));
    const duplicateCount = duplicateCounts.get(normalizeShortcutKey(entry.shortcut)) ?? 0;
    const conflictsBuiltIn = builtInShortcuts.has(normalizeShortcutKey(entry.shortcut));
    const conflictLabel = shortcutConflictLabel({
      validationMessage: validation.valid ? "" : validation.message,
      duplicateCount,
      conflictsBuiltIn,
      targetMissing: !target,
    });
    return {
      ...entry,
      targetLabel: target?.label ?? "目标不存在",
      targetDetail: target?.explain ?? "请重新选择一个可用目标",
      statusLabel: appShortcutStatusLabel({
        enabled: entry.enabled,
        valid: validation.valid,
        duplicateCount,
        conflictsBuiltIn,
        targetMissing: !target,
      }),
      conflictLabel,
    };
  });
}

export function shortcutPageOverview(input: {
  hotkey: string;
  saveLabel: string;
  aliasCount: number;
  targetCount: number;
  customGlobalCount: number;
  customAppCount: number;
  builtinAppCount: number;
}): ShortcutPageOverview {
  return {
    cards: [
      {
        label: "呼出快捷键",
        value: input.hotkey || "未设置",
        detail: input.saveLabel,
      },
      {
        label: "应用快捷键",
        value: input.customAppCount > 0
          ? `${input.builtinAppCount} 个内置 / ${input.customAppCount} 个自定义`
          : `${input.builtinAppCount} 个内置`,
        detail: input.customAppCount > 0 ? "自定义快捷键可编辑" : "可添加自定义应用快捷键",
      },
      {
        label: "指令别名",
        value: `${input.aliasCount} 个`,
        detail: `${input.targetCount} 个可绑定目标`,
      },
    ],
    emptyStates: {
      global: input.customGlobalCount > 0
        ? `${input.customGlobalCount} 个自定义全局快捷键`
        : "暂无自定义全局快捷键；首版只启用主呼出快捷键。",
      app: input.customAppCount > 0
        ? `${input.customAppCount} 个自定义应用快捷键`
        : "暂无自定义应用快捷键；当前先展示主程序内置快捷键。",
      alias: input.aliasCount > 0
        ? `${input.aliasCount} 个指令别名`
        : "暂无指令别名；可从此页或所有指令页添加短词映射。",
    },
  };
}

function nextAppShortcut(existingShortcuts: string[], platform: HotkeyPlatform | string): string {
  const existing = new Set(existingShortcuts.map(normalizeShortcutKey));
  const mod = platform === "mac" ? "Command" : "Ctrl";
  const alt = platform === "mac" ? "Option" : "Alt";
  const candidates = platform === "mac"
    ? [
        ...Array.from({ length: 9 }, (_, index) => `${mod}+${alt}+${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `${mod}+Shift+${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `${mod}+${index + 1}`),
      ]
    : [
        ...Array.from({ length: 9 }, (_, index) => `${mod}+${alt}+${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `${mod}+Shift+${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `${mod}+${index + 1}`),
      ];
  return candidates.find((shortcut) => !existing.has(normalizeShortcutKey(shortcut))) ?? `${mod}+9`;
}

function shortcutCounts(entries: AppShortcutEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = normalizeShortcutKey(entry.shortcut);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function appShortcutStatusLabel(input: {
  enabled: boolean;
  valid: boolean;
  duplicateCount: number;
  conflictsBuiltIn: boolean;
  targetMissing: boolean;
}) {
  if (!input.enabled) return "已停用";
  if (!input.valid) return "无效";
  if (input.targetMissing) return "目标缺失";
  if (input.duplicateCount > 1) return "重复";
  if (input.conflictsBuiltIn) return "冲突";
  return "已启用";
}

function shortcutConflictLabel(input: {
  validationMessage: string;
  duplicateCount: number;
  conflictsBuiltIn: boolean;
  targetMissing: boolean;
}) {
  if (input.validationMessage) return input.validationMessage;
  if (input.duplicateCount > 1) return `与 ${input.duplicateCount - 1} 个自定义快捷键重复`;
  if (input.conflictsBuiltIn) return "与内置快捷键冲突";
  if (input.targetMissing) return "目标不存在，请重新选择";
  return "无冲突";
}

function normalizeShortcutKey(shortcut: string) {
  return shortcut.trim().replace(/\s+/g, "").toLowerCase();
}

function normalizePlatform(platform: HotkeyPlatform | string): HotkeyPlatform {
  if (platform === "windows" || platform === "linux" || platform === "mac") return platform;
  return "mac";
}

function validateAppShortcut(shortcut: string, platform: HotkeyPlatform) {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { valid: false, message: "快捷键不能为空" };

  const primary = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  if (!primary || isModifierOnly(primary, platform)) {
    return { valid: false, message: "快捷键需要包含主键" };
  }
  if (modifiers.length === 0) {
    return { valid: false, message: "快捷键需要包含至少一个修饰键" };
  }

  const normalized = [...modifiers.map((modifier) => normalizeModifierLabel(modifier, platform)), normalizePrimaryLabel(primary)]
    .filter(Boolean)
    .join("+");
  if (platform === "mac" && new Set([
    "Command+Space",
    "Command+Option+Space",
    "Command+Tab",
    "Command+Shift+3",
    "Command+Shift+4",
    "Command+Shift+5",
    "Control+Space",
  ]).has(normalized)) {
    return { valid: false, message: "该组合通常被系统占用，请换一个快捷键" };
  }

  return { valid: true, message: "可用" };
}

function isModifierOnly(value: string, platform: HotkeyPlatform) {
  return ["Alt", "Control", "Ctrl", "Meta", "Shift", "Command", "Option", "OS"]
    .map((modifier) => normalizeModifierLabel(modifier, platform))
    .includes(normalizeModifierLabel(value, platform));
}

function normalizePrimaryLabel(value: string) {
  if (value === " ") return "Space";
  if (value.length === 1) return value.toUpperCase();
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : "";
}

function normalizeModifierLabel(modifier: string, platform: HotkeyPlatform) {
  const normalized = modifier.trim().toLowerCase();
  if (platform === "mac") {
    if (["cmd", "command", "meta"].includes(normalized)) return "Command";
    if (["ctrl", "control"].includes(normalized)) return "Control";
    if (["alt", "option"].includes(normalized)) return "Option";
    if (normalized === "shift") return "Shift";
  }
  if (["cmd", "command", "meta"].includes(normalized)) return "Meta";
  if (["ctrl", "control"].includes(normalized)) return "Ctrl";
  if (["alt", "option"].includes(normalized)) return "Alt";
  if (normalized === "shift") return "Shift";
  return modifier.trim();
}

export function commandCenterOverview(
  targets: CommandCenterTarget[],
  aliases: CommandCenterAlias[],
): CommandCenterOverview {
  const rows = normalizedCommandCenterRows(targets, aliases);
  const groups = COMMAND_CENTER_SOURCE_ORDER.map((source) => {
    const sourceRows = rows.filter((row) => row.source === source);
    return {
      ...commandCenterSourceMeta(source),
      count: sourceRows.length,
      enabledCount: sourceRows.filter((row) => row.enabled).length,
      aliasCount: sourceRows.reduce((total, row) => total + row.aliases.length, 0),
    };
  });

  return {
    totalTargets: rows.length,
    enabledTargets: rows.filter((row) => row.enabled).length,
    aliasCount: normalizeCommandCenterAliases(aliases).length,
    enabledAliasCount: normalizeCommandCenterAliases(aliases).filter((alias) => alias.enabled !== false).length,
    groups,
  };
}

export function commandCenterRows(input: CommandCenterRowsInput): CommandCenterRow[] {
  const query = input.query.trim().toLowerCase();
  return normalizedCommandCenterRows(input.targets, input.aliases, input.pinnedCodes ?? [])
    .filter((row) => input.source === "all" || row.source === input.source)
    .filter((row) => {
      if (input.status === "enabled") return row.enabled;
      if (input.status === "disabled") return !row.enabled;
      return true;
    })
    .filter((row) => {
      if (!query) return true;
      return [
        row.label,
        row.explain,
        row.code,
        row.sourceLabel,
        row.statusLabel,
        row.pinStatusLabel,
        ...row.aliases,
      ].some((value) => value.toLowerCase().includes(query));
    })
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      const sourceDelta = COMMAND_CENTER_SOURCE_ORDER.indexOf(left.source) - COMMAND_CENTER_SOURCE_ORDER.indexOf(right.source);
      if (sourceDelta !== 0) return sourceDelta;
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return left.label.localeCompare(right.label, "zh-Hans-CN");
    });
}

export function commandCenterSourceForCode(code: string): CommandCenterSourceId {
  if (code.startsWith("system:")) return "system";
  if (code.startsWith("local:") || code.startsWith("local-app:")) return "local";
  if (code.startsWith("web:") || code.startsWith("url:")) return "web";
  return "plugin";
}

function normalizedCommandCenterRows(
  targets: CommandCenterTarget[],
  aliases: CommandCenterAlias[],
  pinnedCodes: string[] = [],
): CommandCenterRow[] {
  const normalizedPinnedCodes = new Set(pinnedCodes.map((code) => code.trim()).filter(Boolean));
  const aliasMap = new Map<string, CommandCenterAlias[]>();
  for (const alias of normalizeCommandCenterAliases(aliases)) {
    const list = aliasMap.get(alias.targetCode) ?? [];
    list.push(alias);
    aliasMap.set(alias.targetCode, list);
  }

  return targets
    .map((target) => normalizeCommandCenterTarget(target))
    .filter((target): target is Required<CommandCenterTarget> => Boolean(target))
    .map((target) => {
      const source = target.source ?? commandCenterSourceForCode(target.code);
      const meta = commandCenterSourceMeta(source);
      const targetAliases = aliasMap.get(target.code) ?? [];
      const enabledAliases = targetAliases.filter((alias) => alias.enabled !== false).map((alias) => alias.alias);
      const aliases = targetAliases.map((alias) => alias.alias);
      const pinned = normalizedPinnedCodes.has(target.code);
      return {
        code: target.code,
        label: target.label,
        explain: target.explain,
        source,
        sourceLabel: meta.label,
        statusLabel: target.enabled === false ? "已停用" : "已启用",
        pinStatusLabel: pinned ? "已固定" : "未固定",
        pinLabel: pinned ? "取消固定" : "固定",
        enabled: target.enabled !== false,
        pinned,
        aliases,
        enabledAliases,
        aliasLabel: targetAliases.length === 0
          ? "暂无别名"
          : `${targetAliases.length} 个别名 / ${enabledAliases.length} 个启用`,
        aliasPreview: (enabledAliases.length > 0 ? enabledAliases : aliases).slice(0, 3),
        aliasHint: commandCenterAliasHint(aliases.length, enabledAliases.length),
        aliasActionLabel: targetAliases.length === 0 ? "添加别名" : "管理别名",
      };
    });
}

function commandCenterAliasHint(aliasCount: number, enabledAliasCount: number): string {
  if (aliasCount === 0) return "未设置短词";
  if (enabledAliasCount === 0) return "别名均已停用";
  if (aliasCount === enabledAliasCount) return `${enabledAliasCount} 个别名可用`;
  return `${enabledAliasCount}/${aliasCount} 个别名可用`;
}

function commandCenterSourceMeta(source: CommandCenterSourceId) {
  if (source === "system") {
    return { id: source, label: "系统指令", description: "设置、插件管理、导入和 Agent 面板" };
  }
  if (source === "local") {
    return { id: source, label: "本地启动", description: "文件、文件夹和本地应用入口" };
  }
  if (source === "web") {
    return { id: source, label: "网页快开", description: "关键词搜索和固定网址模板" };
  }
  return { id: source, label: "插件指令", description: "插件声明的功能和匹配指令" };
}

function normalizeCommandCenterTarget(target: CommandCenterTarget): Required<CommandCenterTarget> | null {
  const code = stringValue(target.code);
  const label = stringValue(target.label);
  if (!code || !label) return null;
  const source = target.source ?? commandCenterSourceForCode(code);
  return {
    code,
    label,
    explain: stringValue(target.explain),
    source,
    enabled: target.enabled !== false,
  };
}

function normalizeCommandCenterAliases(aliases: CommandCenterAlias[]): Required<CommandCenterAlias>[] {
  return aliases
    .map((alias) => {
      const normalized = {
        alias: stringValue(alias.alias),
        targetCode: stringValue(alias.targetCode),
        enabled: alias.enabled !== false,
      };
      return normalized.alias && normalized.targetCode ? normalized : null;
    })
    .filter((alias): alias is Required<CommandCenterAlias> => Boolean(alias));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function generalUnsupportedCapabilities(): CapabilityStatus[] {
  return [
    {
      id: "disableGpuAcceleration",
      label: "关闭 GPU 加速",
      description: "启动参数需要在应用重启前配置，当前 UI 不提供假开关。",
      status: "未接入启动参数",
      available: false,
    },
  ];
}

export function generalOverviewCards(input: {
  hotkey: string;
  saveLabel: string;
  launchAtLogin: boolean;
  showTrayIcon: boolean;
  localAppSearch: boolean;
  localLaunchSearch: boolean;
  unsupportedCount: number;
}): GeneralOverviewCard[] {
  const searchEnabledCount = [input.localAppSearch, input.localLaunchSearch].filter(Boolean).length;
  const unsupportedCount = Math.max(0, Math.floor(input.unsupportedCount));
  return [
    {
      label: "呼出快捷键",
      value: input.hotkey.trim() || "未设置",
      detail: `${input.saveLabel || "待保存"}；点击输入框可重新录制`,
      tone: input.hotkey.trim() ? "ready" : "warning",
    },
    {
      label: "系统入口",
      value: `${input.launchAtLogin ? "开机启动" : "手动启动"} / ${input.showTrayIcon ? "托盘显示" : "托盘关闭"}`,
      detail: input.launchAtLogin ? "登录时启动；托盘显示可单独控制" : "登录时不自动启动；托盘显示可单独控制",
      tone: input.launchAtLogin || input.showTrayIcon ? "ready" : "normal",
    },
    {
      label: "搜索来源",
      value: `${searchEnabledCount}/2 启用`,
      detail: `${input.localAppSearch ? "本地应用" : "本地应用关闭"}；${input.localLaunchSearch ? "本地启动" : "本地启动关闭"}`,
      tone: searchEnabledCount === 2 ? "ready" : "warning",
    },
    {
      label: "暂缓能力",
      value: `${unsupportedCount} 项暂缓`,
      detail: "GPU 启动参数仍未接入",
      tone: unsupportedCount > 0 ? "warning" : "normal",
    },
  ];
}

export function dataOverviewCards(input: {
  settingsStatusLabel: string;
  commandHistoryCount: number;
  commandHistoryTopLabel: string;
  clipboardHistoryCount: number;
  auditCount: number;
  pluginCount: number;
  pluginDataDocuments: number;
  hasTauriRuntime: boolean;
}): DataOverviewCard[] {
  const desktopValue = input.hasTauriRuntime ? "" : "桌面端读取";
  return [
    {
      label: "设置数据",
      value: input.settingsStatusLabel || "已保存",
      detail: "主题、快捷键、网页快开、本地启动和命令别名只保存在本机配置中",
      tone: "private",
    },
    {
      label: "最近使用",
      value: `${Math.max(0, input.commandHistoryCount)} 条`,
      detail: input.commandHistoryTopLabel
        ? `最近入口：${input.commandHistoryTopLabel}`
        : "首页最近使用为空，执行命令后会自动记录",
      tone: "normal",
    },
    {
      label: "剪贴板历史",
      value: desktopValue || `${Math.max(0, input.clipboardHistoryCount)} 条`,
      detail: "Agent 可检索本地文本历史，但必须经过授权工具和审计链路",
      tone: input.hasTauriRuntime ? "private" : "desktop",
    },
    {
      label: "审计记录",
      value: desktopValue || `${Math.max(0, input.auditCount)} 条`,
      detail: "记录 MCP/Agent 调用的输入、输出、权限结果和本地副作用；支持本地保留策略清理和文件归档",
      tone: input.hasTauriRuntime ? "private" : "desktop",
    },
    {
      label: "插件数据",
      value: desktopValue || `${Math.max(0, input.pluginDataDocuments)} 条文档`,
      detail: `${Math.max(0, input.pluginCount)} 个插件的本地 db 数据，可导出或清空`,
      tone: input.hasTauriRuntime ? "normal" : "desktop",
    },
  ];
}

export function auditRetentionPolicyRows(input: {
  retentionDays: number;
  keepLatest: number;
  auditCount: number;
  hasTauriRuntime: boolean;
}): AuditRetentionPolicyRow[] {
  const retentionDays = Math.max(1, Math.floor(input.retentionDays));
  const keepLatest = Math.max(1, Math.floor(input.keepLatest));
  const auditCount = Math.max(0, Math.floor(input.auditCount));
  const overLimit = auditCount > keepLatest;
  return [
    {
      label: "保留时间",
      value: `${retentionDays} 天`,
      detail: `清理早于 ${retentionDays} 天的 Agent/MCP 审计记录`,
      tone: "private",
    },
    {
      label: "数量上限",
      value: `${keepLatest} 条`,
      detail: "超过上限时仅保留最新审计记录",
      tone: "normal",
    },
    {
      label: "当前状态",
      value: input.hasTauriRuntime ? `${auditCount} 条` : "桌面端读取",
      detail: input.hasTauriRuntime
        ? (overLimit ? "可清理超出策略的旧审计记录" : "可清理超出策略的旧审计；当前未超过数量上限")
        : "浏览器预览不会读取真实审计数据库",
      tone: input.hasTauriRuntime ? (overLimit ? "warning" : "private") : "desktop",
    },
  ];
}

export function aiOverviewCards(input: {
  providerLabel: string;
  providerEnabled: boolean;
  configReady: boolean;
  defaultModel: string;
  useForAgent: boolean;
  hasApiKey: boolean;
  lastConnectionOk: boolean | null;
  lastConnectionLabel: string;
  hasTauriRuntime: boolean;
}): AiOverviewCard[] {
  const desktopConnectionValue = input.hasTauriRuntime ? "" : "桌面端测试";
  const providerValue = input.providerEnabled ? input.providerLabel : "未启用";
  const model = input.defaultModel.trim();
  const modelValue = model || "未设置";
  const agentEnabled = input.providerEnabled && input.configReady && input.useForAgent;
  const connectionLabel = input.lastConnectionLabel.trim();
  const connectionValue = desktopConnectionValue
    || (input.lastConnectionOk === true ? "连接正常" : input.lastConnectionOk === false ? "连接失败" : "未测试");
  const connectionTone = !input.hasTauriRuntime
    ? "desktop"
    : input.lastConnectionOk === true
      ? "ready"
      : input.lastConnectionOk === false
        ? "warning"
        : input.configReady
          ? "normal"
          : "warning";

  return [
    {
      label: "模型提供商",
      value: providerValue,
      detail: input.providerEnabled
        ? input.configReady
          ? "配置已保存，桌面端可用于连接测试和本地 Agent 工具"
          : "已选择提供商，但 Base URL、模型名或必要密钥还不完整"
        : "ask_ai_model 不会调用任何远端或本地模型",
      tone: input.providerEnabled ? (input.configReady ? "ready" : "warning") : "disabled",
    },
    {
      label: "默认模型",
      value: modelValue,
      detail: model
        ? "Agent 工具和内置 AI 能力会优先使用这个模型名"
        : "需要填写默认模型后才能启用连接测试和 Agent 默认模型",
      tone: model ? "normal" : "warning",
    },
    {
      label: "Agent 默认",
      value: agentEnabled ? "启用" : input.useForAgent ? "未生效" : "未启用",
      detail: agentEnabled
        ? "ask_ai_model 工具会读取这组本地配置，仍受 MCP 权限和审计约束"
        : input.useForAgent
          ? "配置完整后 ask_ai_model 才能使用这组模型配置"
          : "保持关闭时，Agent 不会默认读取这组模型设置",
      tone: agentEnabled ? "private" : input.useForAgent ? "warning" : "normal",
    },
    {
      label: "连接状态",
      value: connectionValue,
      detail: !input.hasTauriRuntime
        ? "浏览器预览不读取真实密钥，需在 macOS 桌面应用中测试"
        : connectionLabel
          || (input.configReady
            ? `可读取 /models 验证配置；${input.hasApiKey ? "API Key 已填写" : "本地模型可不填 API Key"}`
            : "配置完整后才能读取 /models 验证默认模型"),
      tone: connectionTone,
    },
  ];
}

export function permissionModeLabel(mode: string): string {
  if (mode === "per_tool") return "按工具授权";
  if (mode === "developer") return "开发者宽松";
  return "保守确认";
}

export function mcpGovernanceOverview(input: {
  tools: McpGovernanceTool[];
  scopePolicies: McpGovernanceScopePolicy[];
  pendingRequestCount: number;
  permissionMode: string;
  hasTauriRuntime: boolean;
}): McpGovernanceOverview {
  const totalTools = input.tools.length;
  const enabledTools = input.tools.filter((tool) => tool.enabled).length;
  const highRiskScopes = input.scopePolicies.filter((policy) => policy.high_risk);
  const blockedHighRiskScopes = highRiskScopes.filter((policy) => policy.decision === "deny");
  const permissionLabel = permissionModeLabel(input.permissionMode);
  const pendingCount = Math.max(0, input.pendingRequestCount);
  const desktopValue = input.hasTauriRuntime ? "" : "桌面端读取";

  return {
    cards: [
      {
        label: "工具白名单",
        value: desktopValue || `${enabledTools}/${totalTools} 启用`,
        detail: "默认只暴露少量内置工具，插件工具需用户手动授权后才会进入 MCP",
        tone: input.hasTauriRuntime ? "ready" : "desktop",
      },
      {
        label: "默认权限",
        value: permissionLabel,
        detail: input.permissionMode === "developer"
          ? "开发者宽松模式会减少确认，适合本机调试时临时使用"
          : "Agent 调用工具时仍会经过本地权限策略和工具授权",
        tone: input.permissionMode === "developer" ? "warning" : "normal",
      },
      {
        label: "高风险 Scope",
        value: desktopValue || `${highRiskScopes.length} 个`,
        detail: input.hasTauriRuntime
          ? `${blockedHighRiskScopes.length} 个已阻断；文件写、网络、shell 等能力应保持显式确认`
          : "文件写、网络、shell 等策略需在桌面应用中查看",
        tone: blockedHighRiskScopes.length > 0 ? "danger" : (input.hasTauriRuntime ? "normal" : "desktop"),
      },
      {
        label: "待确认请求",
        value: desktopValue || `${pendingCount} 条`,
        detail: pendingCount > 0
          ? "有 Agent 请求等待你在本机确认"
          : "当前没有等待确认的工具调用",
        tone: pendingCount > 0 ? "warning" : (input.hasTauriRuntime ? "ready" : "desktop"),
      },
    ],
    auditChain: input.hasTauriRuntime
      ? "本地审计链路：所有 Agent 工具调用都会记录客户端、输入输出、权限结果、路径和副作用。"
      : "本地审计链路需在 macOS 桌面应用中查看，浏览器预览不会读取真实 Agent 调用。",
  };
}

export function mcpScopePolicyRows(policies: McpGovernanceScopePolicy[]): McpScopePolicyRow[] {
  return policies.map((policy) => ({
    ...policy,
    label: policy.label || policy.scope,
    description: policy.description || "Agent 调用相关工具时会按此 scope 策略处理",
    riskLabel: policy.high_risk ? "高风险" : "普通",
    decisionLabel: policy.decision === "deny" ? "阻断" : "确认",
    blocked: policy.decision === "deny",
  }));
}

export function mcpPendingRequestRows(requests: McpPendingRequestInput[]): McpPendingRequestRow[] {
  return requests.map((request) => ({
    id: request.id,
    toolName: request.tool_name,
    clientId: request.client_id,
    scopeLabel: request.scopes.length ? request.scopes.join(", ") : "无 scope",
    argumentPreview: compactJsonPreview(request.arguments),
    createdAt: request.created_at,
    actions: ["允许一次", "允许并记住", "拒绝"],
  }));
}

export function mcpGrantRows(grants: McpGrantInput[]): McpGrantRow[] {
  return grants.map((grant) => ({
    clientId: grant.client_id,
    toolName: grant.tool_name,
    summary: `${grant.client_id} · ${grant.tool_name}`,
    createdAt: grant.created_at,
    updatedAt: grant.updated_at,
  }));
}

export function mcpAuditRows(entries: McpAuditInput[]): McpAuditRow[] {
  return entries.map((entry) => {
    const status = mcpAuditStatus(entry);
    return {
      id: entry.id,
      toolName: entry.tool_name || "unknown_tool",
      clientId: entry.client_id || "unknown",
      timestamp: entry.timestamp || "未知时间",
      statusLabel: status.label,
      tone: status.tone,
      durationLabel: Number.isFinite(entry.duration_ms) ? `${Math.max(0, Math.round(entry.duration_ms))}ms` : "未知",
      preview: compactJsonPreview(entry.error || entry.output || entry.input),
    };
  });
}

function mcpAuditStatus(entry: Pick<McpAuditInput, "status" | "error">): Pick<McpAuditRow, "statusLabel" | "tone"> & { label: string } {
  const status = String(entry.status || "").toLowerCase();
  if (status === "confirmed" || status === "allowed" || status === "success" || status === "ok" || status === "completed") {
    return { label: status === "confirmed" ? "已确认执行" : status === "allowed" ? "已允许" : "已完成", statusLabel: "已完成", tone: "success" };
  }
  if (status === "denied" || status === "rejected" || status === "refused") {
    return { label: "已拒绝", statusLabel: "已拒绝", tone: "denied" };
  }
  if (entry.error || status === "error" || status === "failed" || status === "failure") {
    return { label: "失败", statusLabel: "失败", tone: "error" };
  }
  if (status === "pending" || status === "waiting") {
    return { label: "待确认", statusLabel: "待确认", tone: "pending" };
  }
  return { label: entry.status || "未知", statusLabel: entry.status || "未知", tone: "unknown" };
}

function compactJsonPreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "无参数";
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    const text = String(value);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  }
}

export function httpServiceStatus(input: {
  mcpEnabled: boolean;
  mcpUrl: string;
}): { label: string; summary: string; rows: FactRow[] } {
  return {
    label: "未启用",
    summary: "ZTools 提供传统 HTTP 服务；ATools 首版把本地自动化入口收敛到 MCP，避免两套授权和审计链路并存。",
    rows: [
      { label: "HTTP API", value: "未接入" },
      { label: "推荐替代", value: "MCP 服务" },
      { label: "MCP 状态", value: input.mcpEnabled ? "运行中" : "未启动" },
      { label: "MCP 地址", value: input.mcpUrl || "未启动" },
      { label: "认证方式", value: "本机 Bearer Token + 权限审计" },
    ],
  };
}

export function httpServiceOverviewCards(input: {
  mcpEnabled: boolean;
  mcpUrl: string;
  tokenAvailable: boolean;
}): HttpServiceOverviewCard[] {
  return [
    {
      label: "HTTP API",
      value: "未接入",
      detail: "传统 HTTP show/hide/toggle API 不在当前版本启用",
      tone: "warning",
    },
    {
      label: "替代入口",
      value: input.mcpEnabled ? "MCP 运行中" : "MCP 未启动",
      detail: input.mcpUrl || "本地 MCP 地址需在桌面应用中启动后读取",
      tone: input.mcpEnabled ? "ready" : "warning",
    },
    {
      label: "认证审计",
      value: "Bearer Token",
      detail: "本机 token、权限确认和审计链路统一由 MCP 处理",
      tone: input.tokenAvailable ? "ready" : "normal",
    },
    {
      label: "客户端配置",
      value: input.tokenAvailable ? "可复制" : "stdio fallback",
      detail: input.tokenAvailable
        ? "HTTP MCP 地址和客户端配置可直接复制"
        : "MCP 未就绪时复制 stdio proxy fallback 配置",
      tone: input.tokenAvailable ? "ready" : "warning",
    },
  ];
}

export function aboutProductFacts(input: {
  version: string;
  runtime: string;
  platform: string;
  mcpEnabled: boolean;
}): { title: string; version: string; cards: AboutCard[]; rows: FactRow[] } {
  return {
    title: "ATools 3.0",
    version: input.version,
    cards: [
      {
        label: "桌面底座",
        value: "Tauri + Rust",
        detail: "主进程、本地能力、权限审计和 MCP 服务由 Rust 承担。",
      },
      {
        label: "本地 MCP",
        value: input.mcpEnabled ? "运行中" : "未启动",
        detail: "Agent 通过本机 MCP 调用少量高质量内置工具。",
      },
      {
        label: "插件 UI",
        value: "HTML/JS",
        detail: "保留 uTools/ZTools 插件界面生态，不改为纯 Rust UI。",
      },
    ],
    rows: [
      { label: "版本", value: input.version },
      { label: "运行时", value: input.runtime },
      { label: "平台", value: input.platform || "未知" },
      { label: "开源方向", value: "轻量、本地优先、Agent 友好" },
    ],
  };
}

export function aboutOverviewCards(input: {
  version: string;
  runtime: string;
  platform: string;
  mcpEnabled: boolean;
  agentToolCount: number;
  enabledAgentToolCount: number;
  hasTauriRuntime: boolean;
}): AboutOverviewCard[] {
  const version = input.version.trim() || "unknown";
  const platform = input.platform.trim() || "未知平台";
  const agentToolCount = Math.max(0, Math.floor(input.agentToolCount));
  const enabledAgentToolCount = Math.max(0, Math.floor(input.enabledAgentToolCount));

  return [
    {
      label: "版本",
      value: `v${version}`,
      detail: `${platform}；本地优先的 ATools 3.0 运行壳`,
      tone: "normal",
    },
    {
      label: "桌面运行时",
      value: input.runtime || "未知",
      detail: input.hasTauriRuntime ? "本地路径、插件目录和运行事件可读取" : "浏览器预览无法读取桌面路径",
      tone: input.hasTauriRuntime ? "ready" : "desktop",
    },
    {
      label: "本地 MCP",
      value: input.hasTauriRuntime ? `${enabledAgentToolCount}/${agentToolCount} 工具` : "桌面端读取",
      detail: input.mcpEnabled ? "MCP 运行中；Agent 工具走权限确认和审计" : "MCP 未启动；需在桌面端刷新状态",
      tone: input.mcpEnabled ? "ready" : "desktop",
    },
    {
      label: "诊断包",
      value: input.hasTauriRuntime ? "可复制" : "预览不可用",
      detail: "脱敏诊断不包含 MCP token、AI API Key 或 WebDAV 密码",
      tone: "private",
    },
  ];
}
