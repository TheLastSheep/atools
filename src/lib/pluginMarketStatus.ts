export type PluginMarketCapability = {
  label: string;
  description: string;
  available: boolean;
};

export type PluginMarketOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "warning" | "desktop";
};

export type PluginMarketStatusInput = {
  installedPluginCount: number;
  hasTauriRuntime: boolean;
  customMarketEnabled?: boolean;
  customMarketUrl?: string;
  remoteCatalogLoaded?: boolean;
  remotePluginCount?: number;
  remoteRatedPluginCount?: number;
  remoteSignedPluginCount?: number;
  remoteTrustedPluginCount?: number;
};

export type PluginMarketStatus = {
  state: "disabled" | "ready";
  label: string;
  summary: string;
  installedPluginCount: number;
  hasTauriRuntime: boolean;
  networkMarketAvailable: boolean;
  customMarketConfigured: boolean;
  customMarketUrl: string;
  remoteCatalogLoaded: boolean;
  remotePluginCount: number;
  remoteRatedPluginCount: number;
  remoteSignedPluginCount: number;
  remoteTrustedPluginCount: number;
  localCapabilities: PluginMarketCapability[];
  remoteCapabilities: PluginMarketCapability[];
};

export function pluginMarketStatus(input: PluginMarketStatusInput): PluginMarketStatus {
  const installedPluginCount = Math.max(0, Math.floor(input.installedPluginCount));
  const customMarketUrl = typeof input.customMarketUrl === "string" ? input.customMarketUrl.trim() : "";
  const customMarketConfigured = Boolean(input.customMarketEnabled && customMarketUrl);
  const remoteCatalogLoaded = Boolean(customMarketConfigured && input.remoteCatalogLoaded);
  const remotePluginCount = remoteCatalogLoaded
    ? Math.max(0, Math.floor(input.remotePluginCount ?? 0))
    : 0;
  const remoteRatedPluginCount = remoteCatalogLoaded
    ? Math.max(0, Math.floor(input.remoteRatedPluginCount ?? 0))
    : 0;
  const remoteSignedPluginCount = remoteCatalogLoaded
    ? Math.max(0, Math.floor(input.remoteSignedPluginCount ?? 0))
    : 0;
  const remoteTrustedPluginCount = remoteCatalogLoaded
    ? Math.min(remoteSignedPluginCount, Math.max(0, Math.floor(input.remoteTrustedPluginCount ?? 0)))
    : 0;
  const summary = remoteCatalogLoaded
    ? `已读取自定义市场目录 ${remotePluginCount} 个插件；可查看远程详情${remoteRatedPluginCount ? `和 ${remoteRatedPluginCount} 个评分条目` : ""}，从远程 ZIP 安装或更新插件并显示进度，执行前需确认，并校验目录提供的 SHA-256。目录包含 ${remoteSignedPluginCount} 个签名条目，其中 ${remoteTrustedPluginCount} 个公钥已被本地信任。`
    : customMarketConfigured
      ? `自定义市场地址已保存：${customMarketUrl}。点击刷新可读取远程目录，读取后可确认安装或更新远程 ZIP、显示进度、取消/重试并校验 SHA-256 和 Ed25519 签名。`
      : input.hasTauriRuntime
      ? "网络插件市场下载安装更新需先配置并读取自定义目录；首版请使用内置插件、本地导入和已安装插件管理。"
      : "插件数量、本地数据和远程 ZIP 安装/更新需在桌面应用中查看。";

  return {
    state: remoteCatalogLoaded ? "ready" : "disabled",
    label: remoteCatalogLoaded ? "目录可用" : "未接入",
    summary,
    installedPluginCount,
    hasTauriRuntime: input.hasTauriRuntime,
    networkMarketAvailable: remoteCatalogLoaded,
    customMarketConfigured,
    customMarketUrl,
    remoteCatalogLoaded,
    remotePluginCount,
    remoteRatedPluginCount,
    remoteSignedPluginCount,
    remoteTrustedPluginCount,
    localCapabilities: [
      { label: "内置插件", description: "随应用打包的基础工具可直接搜索使用", available: true },
      { label: "本地导入", description: "从本机 ZTools/uTools 插件目录导入", available: true },
      { label: "启停管理", description: "已安装插件的启用状态可在插件管理中维护", available: true },
      { label: "插件数据导出", description: "桌面运行时可在我的数据页导出插件数据", available: input.hasTauriRuntime },
      {
        label: "自定义地址",
        description: customMarketConfigured
          ? `已配置 ${customMarketUrl}`
          : "可在通用设置保存外部插件市场地址",
        available: input.hasTauriRuntime && customMarketConfigured,
      },
    ],
    remoteCapabilities: [
      {
        label: "目录读取",
        description: remoteCatalogLoaded
          ? `已读取 ${remotePluginCount} 个远程插件条目`
          : "自定义市场 JSON 目录尚未读取",
        available: remoteCatalogLoaded,
      },
      {
        label: "市场搜索",
        description: remoteCatalogLoaded
          ? "可在已读取的远程目录中查看插件名称和描述"
          : "远程插件名称、描述和作者搜索暂未接入",
        available: remoteCatalogLoaded,
      },
      {
        label: "下载/安装/更新",
        description: remoteCatalogLoaded
          ? "可下载远程 ZIP 包并复用本地插件安装/更新流程"
          : "需先读取远程目录后才能安装或更新插件",
        available: remoteCatalogLoaded,
      },
      {
        label: "SHA-256 校验",
        description: remoteCatalogLoaded
          ? "目录条目提供 checksum 或 sha256 时会在解包前验证 ZIP 摘要"
          : "需先读取远程目录并由条目提供 checksum 或 sha256",
        available: remoteCatalogLoaded,
      },
      {
        label: "安装确认",
        description: remoteCatalogLoaded
          ? "安装或更新远程插件前会弹出设置页确认"
          : "需先读取远程目录后才能确认安装或更新",
        available: remoteCatalogLoaded,
      },
      {
        label: "下载进度",
        description: remoteCatalogLoaded
          ? "远程安装或更新时会显示连接、下载、校验、写入和完成阶段"
          : "需先读取远程目录后才能显示安装或更新进度",
        available: remoteCatalogLoaded,
      },
      {
        label: "取消/重试",
        description: remoteCatalogLoaded
          ? "远程安装或更新可取消当前下载，临时网络失败会自动重试并可手动重试"
          : "需先读取远程目录后才能取消或重试远程安装任务",
        available: remoteCatalogLoaded,
      },
      {
        label: "远程详情",
        description: remoteCatalogLoaded
          ? "可查看目录条目的版本、作者、下载地址、校验和主页等详情"
          : "需先读取远程目录后才能查看远程详情",
        available: remoteCatalogLoaded,
      },
      {
        label: "远程评分",
        description: remoteCatalogLoaded
          ? remoteRatedPluginCount > 0
            ? `目录中 ${remoteRatedPluginCount} 个插件提供评分或评分数`
            : "目录已读取，但条目未提供评分字段"
          : "需先读取远程目录并由条目提供评分字段",
        available: remoteCatalogLoaded && remoteRatedPluginCount > 0,
      },
      {
        label: "签名信任",
        description: remoteCatalogLoaded
          ? remoteTrustedPluginCount > 0
            ? `目录中 ${remoteTrustedPluginCount} 个插件的 Ed25519 公钥已在本地 pin`
            : remoteSignedPluginCount > 0
              ? `目录中 ${remoteSignedPluginCount} 个插件提供签名，但公钥尚未在本地 pin`
            : "目录已读取，但条目未提供签名和公钥"
          : "需先读取远程目录并由条目提供签名和公钥",
        available: remoteCatalogLoaded && remoteTrustedPluginCount > 0,
      },
    ],
  };
}

export function pluginMarketOverviewCards(status: PluginMarketStatus): PluginMarketOverviewCard[] {
  const localAvailable = status.localCapabilities.filter((capability) => capability.available).length;
  const remoteAvailable = status.remoteCapabilities.filter((capability) => capability.available).length;

  return [
    {
      label: "市场状态",
      value: status.label,
      detail: status.remoteCatalogLoaded
        ? "自定义远程目录已接入展示、远程详情、评分展示、ZIP 安装/更新、下载进度、SHA-256 校验、Ed25519 签名校验和安装确认"
        : "网络市场、下载安装更新、进度、取消/重试、校验、确认、评分、远程详情和签名信任需先读取自定义目录",
      tone: status.remoteCatalogLoaded ? "ready" : "warning",
    },
    {
      label: "市场地址",
      value: status.customMarketConfigured ? "已配置" : "未配置",
      detail: status.customMarketConfigured
        ? status.customMarketUrl
        : "可在通用设置保存外部市场地址",
      tone: status.customMarketConfigured ? "ready" : "warning",
    },
    {
      label: "本地入口",
      value: `${localAvailable}/${status.localCapabilities.length} 可用`,
      detail: "内置插件、本地导入、启停管理和数据导出作为本地替代入口",
      tone: status.hasTauriRuntime && localAvailable >= 4 ? "ready" : "desktop",
    },
    {
      label: "已安装插件",
      value: status.hasTauriRuntime ? `${status.installedPluginCount} 个` : "桌面端读取",
      detail: status.hasTauriRuntime
        ? "已安装插件可在插件管理中启停和查看详情"
        : "已安装插件数量和状态需在桌面应用中读取",
      tone: status.hasTauriRuntime ? "ready" : "desktop",
    },
    {
      label: "远程能力",
      value: `${remoteAvailable}/${status.remoteCapabilities.length} 可用`,
      detail: status.remoteCatalogLoaded
        ? "目录读取、市场搜索、ZIP 安装/更新、下载进度、取消/重试、SHA-256 校验、安装确认和远程详情可用；有评分或签名条目时展示市场评分和签名信任"
        : "目录读取、市场搜索、下载安装更新、进度、取消/重试、校验、确认、评分详情和签名信任需读取自定义目录",
      tone: remoteAvailable > 0 ? "ready" : "warning",
    },
  ];
}
