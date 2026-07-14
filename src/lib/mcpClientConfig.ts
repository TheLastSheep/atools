import type { McpServerStatus } from "./types";

export const DEFAULT_ATOOLS_APP_COMMAND = "/Applications/ATools 3.0.app/Contents/MacOS/ATools 3.0";

export type McpClientServerConfig = {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  [key: string]: unknown;
};

export type McpClientConfig = {
  mcpServers: Record<string, McpClientServerConfig>;
  [key: string]: unknown;
};

export type McpClientConfigOptions = {
  status?: McpServerStatus | null;
  serverName?: string;
  appCommand?: string;
  homePath?: string;
};

export type McpClientTargetPathOptions = {
  homePath?: string | null;
};

export type McpClientTemplateId = "atools-http" | "atools-stdio" | "claude-desktop" | "cursor";

export type McpClientTemplate = {
  id: McpClientTemplateId;
  label: string;
  description: string;
  transport: "http" | "stdio";
  config: McpClientConfig;
};

export type McpClientInstallPlan = {
  templateId: McpClientTemplateId;
  targetLabel: string;
  targetPath: string;
  suggestedTargetPath: string;
  writeAvailable: boolean;
  writeReason: string;
  writeStateLabel: string;
  writeActionLabel: string;
  steps: string[];
};

export type McpClientConfigInstallResult = {
  target_path: string;
  backup_path?: string | null;
  created: boolean;
  changed: boolean;
  server_name: string;
};

export type McpConnectionView = {
  statusLabel: string;
  statusTone: "ready" | "warning" | "offline";
  httpUrl: string;
  tokenLabel: string;
  tokenAvailable: boolean;
  recommendedTransport: "http" | "stdio";
  securityHint: string;
};

export function mcpHttpUrl(status?: McpServerStatus | null): string | null {
  if (!status?.enabled || !status.bind || !status.token) return null;
  return `http://${status.bind}/mcp`;
}

export function maskMcpToken(token?: string | null): string {
  const value = token?.trim() ?? "";
  if (!value) return "未启动";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function mcpConnectionView(status?: McpServerStatus | null): McpConnectionView {
  const httpUrl = mcpHttpUrl(status);
  if (httpUrl && status?.token) {
    return {
      statusLabel: "运行中",
      statusTone: "ready",
      httpUrl,
      tokenLabel: maskMcpToken(status.token),
      tokenAvailable: true,
      recommendedTransport: "http",
      securityHint: "Token 已隐藏；复制 HTTP 配置会包含 Bearer token。",
    };
  }
  const waitingForToken = Boolean(status?.enabled && status.bind && !status.token);
  return {
    statusLabel: waitingForToken ? "等待 token" : "未启动",
    statusTone: waitingForToken ? "warning" : "offline",
    httpUrl: "未启动",
    tokenLabel: "未启动",
    tokenAvailable: false,
    recommendedTransport: "stdio",
    securityHint: "HTTP MCP 未就绪；可复制 stdio proxy 配置。",
  };
}

export function mcpHttpClientConfig(
  status: McpServerStatus,
  serverName = "atools"
): McpClientConfig {
  const url = mcpHttpUrl(status);
  if (!url) {
    return mcpStdioClientConfig({ serverName });
  }
  return {
    mcpServers: {
      [serverName]: {
        url,
        headers: {
          Authorization: `Bearer ${status.token}`,
        },
      },
    },
  };
}

export function mcpStdioClientConfig(options: Omit<McpClientConfigOptions, "status"> = {}): McpClientConfig {
  const serverName = options.serverName ?? "atools";
  return {
    mcpServers: {
      [serverName]: {
        command: options.appCommand ?? DEFAULT_ATOOLS_APP_COMMAND,
        args: ["--mcp-stdio"],
      },
    },
  };
}

export function mcpClientConfig(options: McpClientConfigOptions = {}): McpClientConfig {
  const serverName = options.serverName ?? "atools";
  if (options.status && mcpHttpUrl(options.status)) {
    return mcpHttpClientConfig(options.status, serverName);
  }
  return mcpStdioClientConfig({
    serverName,
    appCommand: options.appCommand,
  });
}

export function mcpClientConfigText(config: McpClientConfig): string {
  return JSON.stringify(config, null, 2);
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function mergeMcpClientConfig(
  existing: unknown,
  desired: McpClientConfig,
  serverName = "atools"
): McpClientConfig {
  const normalizedServerName = serverName.trim() || "atools";
  const desiredServers = jsonObject(desired.mcpServers, "MCP client config mcpServers");
  const desiredServer = desiredServers[normalizedServerName];
  if (desiredServer === undefined) {
    throw new Error(`MCP client config must include mcpServers.${normalizedServerName}`);
  }

  const existingConfig = existing === null || existing === undefined
    ? {}
    : jsonObject(existing, "Existing MCP client config");
  const existingServers = existingConfig.mcpServers === undefined
    ? {}
    : jsonObject(existingConfig.mcpServers, "Existing mcpServers");

  return {
    ...existingConfig,
    mcpServers: {
      ...existingServers,
      [normalizedServerName]: desiredServer,
    },
  } as McpClientConfig;
}

export function mcpClientInstallResultText(
  template: McpClientTemplate,
  result: McpClientConfigInstallResult
): string {
  const action = result.created ? "已创建" : result.changed ? "已合并" : "无需修改";
  const backup = result.backup_path ? `，备份 ${result.backup_path}` : "";
  return `${action} ${template.label} 到 ${result.target_path}${backup}`;
}

export function mcpClientTemplates(options: McpClientConfigOptions = {}): McpClientTemplate[] {
  const serverName = options.serverName ?? "atools";
  const httpConfig = options.status && mcpHttpUrl(options.status)
    ? mcpHttpClientConfig(options.status, serverName)
    : mcpStdioClientConfig({ serverName, appCommand: options.appCommand });
  const stdioConfig = mcpStdioClientConfig({ serverName, appCommand: options.appCommand });
  const httpReady = options.status && mcpHttpUrl(options.status);

  return [
    {
      id: "atools-http",
      label: "通用 HTTP MCP",
      description: httpReady ? "适合支持 HTTP MCP 和 Bearer token 的客户端" : "HTTP MCP 未就绪，已回退为 stdio proxy 配置",
      transport: httpReady ? "http" : "stdio",
      config: httpConfig,
    },
    {
      id: "atools-stdio",
      label: "通用 stdio proxy",
      description: "适合只支持 stdio MCP 的客户端；权限和审计仍由桌面端处理",
      transport: "stdio",
      config: stdioConfig,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop / Claude Code",
      description: "复制到 Claude 兼容 MCP 配置；推荐 stdio proxy，避免手动同步端口和 token",
      transport: "stdio",
      config: stdioConfig,
    },
    {
      id: "cursor",
      label: "Cursor",
      description: httpReady ? "Cursor 可用 HTTP MCP 配置；端口和 token 来自当前桌面进程" : "HTTP MCP 未就绪，已回退为 stdio proxy 配置",
      transport: httpReady ? "http" : "stdio",
      config: httpConfig,
    },
  ];
}

export function mcpClientTemplateText(template: McpClientTemplate): string {
  return mcpClientConfigText(template.config);
}

function joinHomePath(homePath: string | null | undefined, suffix: string, fallback: string): string {
  const home = homePath?.trim().replace(/\/+$/, "") ?? "";
  return home ? `${home}/${suffix}` : fallback;
}

export function mcpClientSuggestedTargetPath(
  template: McpClientTemplate,
  options: McpClientTargetPathOptions = {}
): string {
  switch (template.id) {
    case "claude-desktop":
      return joinHomePath(
        options.homePath,
        "Library/Application Support/Claude/claude_desktop_config.json",
        "claude_desktop_config.json"
      );
    case "cursor":
      return joinHomePath(options.homePath, ".cursor/mcp.json", "mcp.json");
    case "atools-http":
    case "atools-stdio":
      return "mcp.json";
  }
}

export function mcpClientInstallPlan(
  template: McpClientTemplate,
  options: McpClientTargetPathOptions = {}
): McpClientInstallPlan {
  const baseReason = "可选择目标配置文件自动合并；写入前会备份已有 JSON，只替换或新增 mcpServers.atools。";
  const baseWrite = {
    suggestedTargetPath: mcpClientSuggestedTargetPath(template, options),
    writeAvailable: true,
    writeReason: baseReason,
    writeStateLabel: "可安全合并",
    writeActionLabel: "合并到文件...",
  };
  switch (template.id) {
    case "atools-http":
      return {
        templateId: template.id,
        targetLabel: "支持 HTTP MCP 的客户端配置",
        targetPath: "客户端 MCP 设置",
        ...baseWrite,
        steps: [
          "选择目标配置 JSON，写入前会生成同目录备份。",
          "自动合并 mcpServers.atools，并保留其他 server 和顶层字段。",
          template.transport === "http"
            ? "保留 Authorization Bearer token，并确认地址仍指向 127.0.0.1。"
            : "HTTP 未就绪时使用当前 stdio fallback，后续可在服务启动后重新复制。",
        ],
      };
    case "atools-stdio":
      return {
        templateId: template.id,
        targetLabel: "支持 stdio MCP 的客户端配置",
        targetPath: "客户端 MCP 设置",
        ...baseWrite,
        steps: [
          "选择目标配置 JSON，写入前会生成同目录备份。",
          "自动合并 mcpServers.atools，并保留其他 server 和顶层字段。",
          "确认 command 指向 ATools 桌面端，args 保留 --mcp-stdio。",
        ],
      };
    case "claude-desktop":
      return {
        templateId: template.id,
        targetLabel: "Claude Desktop / Claude Code MCP 配置",
        targetPath: "Claude Desktop: claude_desktop_config.json；Claude Code: ~/.claude.json 或项目 .mcp.json",
        ...baseWrite,
        steps: [
          "选择目标配置 JSON，写入前会生成同目录备份。",
          "合并 mcpServers.atools，不会替换已有 mcpServers。",
          "重启或刷新 Claude 后，在客户端工具列表中确认 ATools 可见。",
        ],
      };
    case "cursor":
      return {
        templateId: template.id,
        targetLabel: "Cursor MCP 配置",
        targetPath: "Cursor 全局 ~/.cursor/mcp.json / 项目 .cursor/mcp.json",
        ...baseWrite,
        steps: [
          "选择目标配置 JSON，写入前会生成同目录备份。",
          "合并 mcpServers.atools 到 Cursor MCP 配置，并保留其他 server。",
          template.transport === "http"
            ? "确认 Authorization Bearer token 未被删掉，并刷新 Cursor MCP 服务。"
            : "HTTP 未就绪时先使用 stdio proxy，后续可重新复制 HTTP 配置。",
        ],
      };
  }
}

export function mcpClientInstallPlans(options: McpClientConfigOptions = {}): McpClientInstallPlan[] {
  return mcpClientTemplates(options).map((template) => mcpClientInstallPlan(template, {
    homePath: options.homePath,
  }));
}
