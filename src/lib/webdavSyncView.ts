import type {
  WebdavBackupPreview,
  WebdavClipboardRestoreResult,
  WebdavPluginDataRestoreResult,
  WebdavRestorePlan,
  WebdavSettingsRestoreResult,
  WebdavSyncSummary,
} from "./types";

export type WebdavSyncButtonInput = {
  hasTauriRuntime: boolean;
  enabled: boolean;
  configReady: boolean;
  syncing: boolean;
};

export type WebdavPreviewButtonInput = WebdavSyncButtonInput & {
  previewing: boolean;
};

export type WebdavRestorePlanButtonInput = WebdavPreviewButtonInput & {
  planning: boolean;
};

export type WebdavSettingsRestoreButtonInput = WebdavRestorePlanButtonInput & {
  restoring: boolean;
  plan: WebdavRestorePlan | null;
};

export type WebdavClipboardRestoreButtonInput = WebdavRestorePlanButtonInput & {
  restoring: boolean;
  plan: WebdavRestorePlan | null;
};

export type WebdavPluginDataRestoreButtonInput = WebdavRestorePlanButtonInput & {
  restoring: boolean;
  plan: WebdavRestorePlan | null;
};

export type WebdavPluginDataSelectedOverwriteButtonInput = WebdavPluginDataRestoreButtonInput & {
  selectedConflicts: number;
};

export type WebdavSyncButtonState = {
  disabled: boolean;
  label: string;
  reason: string;
};

export type WebdavSyncRowsInput = {
  configReady: boolean;
  remotePath: string;
  scopes: string[];
  summary: WebdavSyncSummary | null;
};

export type WebdavSyncRow = {
  label: string;
  value: string;
};

export type WebdavOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "desktop" | "private";
};

export type WebdavOverviewInput = {
  enabled: boolean;
  configReady: boolean;
  hasTauriRuntime: boolean;
  remotePath: string;
  scopes: string[];
  statusLabel: string;
  hasPassword: boolean;
  lastSync: WebdavSyncSummary | null;
  lastPreview: WebdavBackupPreview | null;
  lastRestorePlan: WebdavRestorePlan | null;
};

export function webdavOverviewCards(input: WebdavOverviewInput): WebdavOverviewCard[] {
  const scopes = input.scopes.filter(Boolean);
  const remotePath = input.remotePath.trim() || "/ATools";
  const desktopOnly = !input.hasTauriRuntime;
  const connectionValue = desktopOnly
    ? "桌面端同步"
    : !input.configReady
      ? "配置不完整"
      : input.enabled
        ? "已启用"
        : "未启用";
  const connectionTone: WebdavOverviewCard["tone"] = desktopOnly
    ? "desktop"
    : !input.configReady
      ? "warning"
      : input.enabled
        ? "ready"
        : "normal";
  const latest = webdavLatestResult(input);

  return [
    {
      label: "连接配置",
      value: connectionValue,
      detail: desktopOnly
        ? "浏览器预览不读取真实 WebDAV 账号，需在 macOS 桌面应用中同步"
        : input.configReady
          ? `服务器和用户名已填写；${input.hasPassword ? "密码或 Token 仅本机保存" : "可填写应用专用密码或 Token"}`
          : "填写服务器地址和用户名后才能启用同步",
      tone: connectionTone,
    },
    {
      label: "远端目录",
      value: remotePath,
      detail: "ATools 设置、插件数据、剪贴板历史和 manifest 会统一放在该目录下",
      tone: desktopOnly ? "desktop" : "normal",
    },
    {
      label: "同步范围",
      value: scopes.length > 0 ? `${scopes.length} 项` : "未选择",
      detail: scopes.length > 0 ? scopes.join(" / ") : "至少选择一个范围后再上传备份",
      tone: scopes.length > 0 ? (input.enabled ? "private" : "normal") : "warning",
    },
    {
      label: "最近结果",
      value: desktopOnly ? "桌面端读取" : latest.value || input.statusLabel || "未同步",
      detail: desktopOnly
        ? "远端备份状态需在桌面应用中读取"
        : latest.detail || "检查远端备份只读取 manifest 和文件摘要，不会覆盖本机数据",
      tone: desktopOnly ? "desktop" : latest.tone,
    },
  ];
}

export function webdavSyncButtonState(input: WebdavSyncButtonInput): WebdavSyncButtonState {
  if (input.syncing) {
    return {
      disabled: true,
      label: "同步中...",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "立即同步",
      reason: "需在桌面应用中同步",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "立即同步",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "立即同步",
      reason: "请先启用 WebDAV 配置",
    };
  }
  return {
    disabled: false,
    label: "立即同步",
    reason: "上传设置、插件数据和剪贴板历史到 WebDAV",
  };
}

export function webdavPreviewButtonState(input: WebdavPreviewButtonInput): WebdavSyncButtonState {
  if (input.previewing) {
    return {
      disabled: true,
      label: "检查中...",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "检查远端备份",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "检查远端备份",
      reason: "需在桌面应用中检查",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "检查远端备份",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "检查远端备份",
      reason: "请先启用 WebDAV 配置",
    };
  }
  return {
    disabled: false,
    label: "检查远端备份",
    reason: "下载 manifest 并预览远端备份内容",
  };
}

export function webdavRestorePlanButtonState(
  input: WebdavRestorePlanButtonInput,
): WebdavSyncButtonState {
  if (input.planning) {
    return {
      disabled: true,
      label: "生成中...",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "生成恢复计划",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "生成恢复计划",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "生成恢复计划",
      reason: "需在桌面应用中生成",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "生成恢复计划",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "生成恢复计划",
      reason: "请先启用 WebDAV 配置",
    };
  }
  return {
    disabled: false,
    label: "生成恢复计划",
    reason: "只生成本机与远端差异，不会写入本机数据",
  };
}

export function webdavSettingsRestoreButtonState(
  input: WebdavSettingsRestoreButtonInput,
): WebdavSyncButtonState {
  if (input.restoring) {
    return {
      disabled: true,
      label: "恢复中...",
      reason: "正在恢复 WebDAV 设置",
    };
  }
  if (input.planning) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "需在桌面应用中恢复",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "请先启用 WebDAV 配置",
    };
  }

  const settingsItem = input.plan?.items.find((item) => item.scope === "settings");
  if (!settingsItem) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "请先生成恢复计划",
    };
  }
  if (settingsItem.action === "unchanged" || settingsItem.changed_keys.length === 0) {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "远端设置与本机一致",
    };
  }
  if (settingsItem.action !== "would_update") {
    return {
      disabled: true,
      label: "恢复设置",
      reason: "当前恢复计划不能直接写入设置",
    };
  }
  return {
    disabled: false,
    label: "恢复设置",
    reason: "仅恢复设置项，插件数据和剪贴板不会写入",
  };
}

export function webdavClipboardRestoreButtonState(
  input: WebdavClipboardRestoreButtonInput,
): WebdavSyncButtonState {
  if (input.restoring) {
    return {
      disabled: true,
      label: "导入中...",
      reason: "正在导入 WebDAV 剪贴板历史",
    };
  }
  if (input.planning) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "需在桌面应用中导入剪贴板历史",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "请先启用 WebDAV 配置",
    };
  }

  const clipboardItem = input.plan?.items.find((item) => item.scope === "clipboard");
  if (!clipboardItem) {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "请先生成恢复计划",
    };
  }
  if (clipboardItem.action === "unchanged") {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "远端剪贴板历史与本机一致",
    };
  }
  if (clipboardItem.action !== "would_replace") {
    return {
      disabled: true,
      label: "导入剪贴板",
      reason: "当前恢复计划不能导入剪贴板历史",
    };
  }
  return {
    disabled: false,
    label: "导入剪贴板",
    reason: "追加导入远端剪贴板历史，不会清空本机历史",
  };
}

export function webdavPluginDataRestoreButtonState(
  input: WebdavPluginDataRestoreButtonInput,
): WebdavSyncButtonState {
  if (input.restoring) {
    return {
      disabled: true,
      label: "导入中...",
      reason: "正在导入 WebDAV 插件数据",
    };
  }
  if (input.planning) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "需在桌面应用中导入插件数据",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "请先启用 WebDAV 配置",
    };
  }

  const pluginItem = input.plan?.items.find((item) => item.scope === "plugins");
  if (!pluginItem) {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "请先生成恢复计划",
    };
  }
  if (pluginItem.action === "unchanged") {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "远端插件数据与本机一致",
    };
  }
  if (pluginItem.action !== "would_replace") {
    return {
      disabled: true,
      label: "导入插件数据",
      reason: "当前恢复计划不能导入插件数据",
    };
  }
  return {
    disabled: false,
    label: "导入插件数据",
    reason: "追加导入远端插件文档，冲突文档会跳过",
  };
}

export function webdavPluginDataOverwriteButtonState(
  input: WebdavPluginDataRestoreButtonInput,
): WebdavSyncButtonState {
  if (input.restoring) {
    return {
      disabled: true,
      label: "覆盖中...",
      reason: "正在覆盖 WebDAV 插件数据冲突",
    };
  }
  if (input.planning) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "需在桌面应用中覆盖插件数据冲突",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "请先启用 WebDAV 配置",
    };
  }

  const pluginItem = input.plan?.items.find((item) => item.scope === "plugins");
  if (!pluginItem) {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "请先生成恢复计划",
    };
  }
  if (pluginItem.action === "unchanged") {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "远端插件数据与本机一致",
    };
  }
  if (pluginItem.action !== "would_replace") {
    return {
      disabled: true,
      label: "覆盖冲突数据",
      reason: "当前恢复计划不能覆盖插件数据冲突",
    };
  }
  return {
    disabled: false,
    label: "覆盖冲突数据",
    reason: "用远端同 ID 文档覆盖本机冲突文档",
  };
}

export function webdavPluginDataSelectedOverwriteButtonState(
  input: WebdavPluginDataSelectedOverwriteButtonInput,
): WebdavSyncButtonState {
  if (input.restoring) {
    return {
      disabled: true,
      label: "覆盖中...",
      reason: "正在覆盖 WebDAV 插件数据冲突",
    };
  }
  if (input.planning) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "正在比较本机与远端备份",
    };
  }
  if (input.previewing) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "正在读取远端备份",
    };
  }
  if (input.syncing) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "正在上传 WebDAV 备份",
    };
  }
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "需在桌面应用中覆盖插件数据冲突",
    };
  }
  if (!input.configReady) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "待填写服务器和用户名",
    };
  }
  if (!input.enabled) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "请先启用 WebDAV 配置",
    };
  }

  const pluginItem = input.plan?.items.find((item) => item.scope === "plugins");
  if (!pluginItem) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "请先生成恢复计划",
    };
  }
  if (pluginItem.action === "unchanged") {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "远端插件数据与本机一致",
    };
  }
  if (pluginItem.action !== "would_replace") {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "当前恢复计划不能覆盖插件数据冲突",
    };
  }
  if ((pluginItem.plugin_conflicts ?? []).length === 0) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "恢复计划没有可选择的插件数据冲突",
    };
  }
  if (input.selectedConflicts <= 0) {
    return {
      disabled: true,
      label: "覆盖选中冲突",
      reason: "请先选择要覆盖的冲突文档",
    };
  }
  return {
    disabled: false,
    label: "覆盖选中冲突",
    reason: `只覆盖已勾选的 ${input.selectedConflicts} 条插件数据冲突`,
  };
}

export function webdavSyncRows(input: WebdavSyncRowsInput): WebdavSyncRow[] {
  const scopes = input.scopes.filter(Boolean);
  const rows: WebdavSyncRow[] = [
    {
      label: "连接",
      value: input.configReady ? "配置完整" : "待填写服务器和用户名",
    },
    {
      label: "远端目录",
      value: input.remotePath || "/ATools",
    },
    {
      label: "同步范围",
      value: scopes.length > 0 ? scopes.join(" / ") : "未选择",
    },
    {
      label: "执行能力",
      value: "已接入 WebDAV 上传校验",
    },
  ];

  if (!input.summary) return rows;

  rows.push({
    label: "上传文件",
    value: `${input.summary.files_uploaded.length} 个 / ${formatBytes(input.summary.uploaded_bytes)}`,
  });
  rows.push({
    label: "远端 manifest",
    value: input.summary.remote_manifest_verified
      ? `已验证 / ${formatBytes(input.summary.remote_manifest_bytes)}`
      : "未验证",
  });
  rows.push({
    label: "耗时",
    value: `${input.summary.duration_ms} ms`,
  });
  return rows;
}

function webdavLatestResult(input: WebdavOverviewInput): Pick<WebdavOverviewCard, "value" | "detail" | "tone"> {
  if (input.lastRestorePlan) {
    const highRiskCount = input.lastRestorePlan.items.filter((item) => item.high_risk).length;
    return {
      value: "有恢复计划",
      detail: `${input.lastRestorePlan.items.length} 个范围待确认${highRiskCount ? `，${highRiskCount} 个高风险` : ""}`,
      tone: highRiskCount > 0 ? "warning" : "ready",
    };
  }
  if (input.lastPreview) {
    return {
      value: "已检查",
      detail: `远端 manifest 可读，发现 ${input.lastPreview.files.length} 个备份文件`,
      tone: "ready",
    };
  }
  if (input.lastSync) {
    return {
      value: input.lastSync.remote_manifest_verified ? "已同步" : "已上传",
      detail: input.lastSync.remote_manifest_verified
        ? `上传 ${input.lastSync.files_uploaded.length} 个文件，manifest 已验证`
        : `上传 ${input.lastSync.files_uploaded.length} 个文件，manifest 未验证`,
      tone: input.lastSync.remote_manifest_verified ? "ready" : "warning",
    };
  }
  if (!input.configReady) {
    return {
      value: "配置不完整",
      detail: "配置完整后可同步、检查远端备份并生成恢复计划",
      tone: "warning",
    };
  }
  return {
    value: input.statusLabel || (input.enabled ? "待同步" : "未启用"),
    detail: input.enabled ? "可以先检查远端备份，确认后再上传或恢复" : "启用后才会上传设置、插件数据或剪贴板历史",
    tone: input.enabled ? "normal" : "warning",
  };
}

export function webdavPreviewRows(preview: WebdavBackupPreview | null): WebdavSyncRow[] {
  if (!preview) return [];
  const rows: WebdavSyncRow[] = [
    {
      label: "远端备份",
      value: `${preview.manifest_kind || "未知类型"} · ${preview.exported_at || "未知时间"}`,
    },
    {
      label: "远端目录",
      value: preview.remote_path || "/ATools",
    },
    {
      label: "文件",
      value: `${preview.files.length} 个`,
    },
  ];
  for (const file of preview.files) {
    rows.push({
      label: file.name,
      value: `${file.summary} · ${formatBytes(file.downloaded_bytes)}`,
    });
  }
  rows.push({
    label: "检查耗时",
    value: `${preview.duration_ms} ms`,
  });
  return rows;
}

export function webdavRestorePlanRows(plan: WebdavRestorePlan | null): WebdavSyncRow[] {
  if (!plan) return [];
  const rows: WebdavSyncRow[] = [
    {
      label: "恢复计划",
      value: `${plan.manifest_kind || "未知类型"} · ${plan.exported_at || "未知时间"}`,
    },
    {
      label: "远端目录",
      value: plan.remote_path || "/ATools",
    },
    {
      label: "范围",
      value: `${plan.items.length} 项`,
    },
  ];
  for (const item of plan.items) {
    rows.push({
      label: item.scope,
      value: restorePlanItemText(item),
    });
  }
  rows.push({
    label: "计划耗时",
    value: `${plan.duration_ms} ms`,
  });
  return rows;
}

export function webdavSettingsRestoreRows(
  result: WebdavSettingsRestoreResult | null,
): WebdavSyncRow[] {
  if (!result) return [];
  return [
    {
      label: "设置恢复",
      value: `${result.manifest_kind || "未知类型"} · ${result.exported_at || "未知时间"}`,
    },
    {
      label: "远端目录",
      value: result.remote_path || "/ATools",
    },
    {
      label: "已恢复",
      value: result.applied_keys.length > 0 ? result.applied_keys.join("、") : "无变化",
    },
    {
      label: "已跳过",
      value: result.skipped_keys.length > 0 ? result.skipped_keys.join("、") : "无",
    },
    {
      label: "恢复耗时",
      value: `${result.duration_ms} ms`,
    },
  ];
}

export function webdavClipboardRestoreRows(
  result: WebdavClipboardRestoreResult | null,
): WebdavSyncRow[] {
  if (!result) return [];
  return [
    {
      label: "剪贴板导入",
      value: `${result.manifest_kind || "未知类型"} · ${result.exported_at || "未知时间"}`,
    },
    {
      label: "远端目录",
      value: result.remote_path || "/ATools",
    },
    {
      label: "远端条目",
      value: `${result.remote_entries} 条`,
    },
    {
      label: "已导入",
      value: `${result.imported_entries} 条`,
    },
    {
      label: "已跳过",
      value: `${result.skipped_entries} 条`,
    },
    {
      label: "导入耗时",
      value: `${result.duration_ms} ms`,
    },
  ];
}

export function webdavPluginDataRestoreRows(
  result: WebdavPluginDataRestoreResult | null,
): WebdavSyncRow[] {
  if (!result) return [];
  return [
    {
      label: "插件数据导入",
      value: `${result.manifest_kind || "未知类型"} · ${result.exported_at || "未知时间"}`,
    },
    {
      label: "远端目录",
      value: result.remote_path || "/ATools",
    },
    {
      label: "远端插件",
      value: `${result.remote_plugins} 个`,
    },
    {
      label: "远端文档",
      value: `${result.remote_documents} 条`,
    },
    {
      label: "已导入",
      value: `${result.imported_documents} 条`,
    },
    {
      label: "已覆盖",
      value: `${result.overwritten_documents} 条`,
    },
    {
      label: "已跳过",
      value: `${result.skipped_documents} 条`,
    },
    {
      label: "冲突文档",
      value: `${result.conflict_documents} 条`,
    },
    {
      label: "缺失插件",
      value: `${result.missing_plugins} 个`,
    },
    {
      label: "导入耗时",
      value: `${result.duration_ms} ms`,
    },
  ];
}

function restorePlanItemText(item: WebdavRestorePlan["items"][number]) {
  const action = restoreActionLabel(item.action);
  const change = item.changed_keys.length > 0
    ? item.changed_keys.join("、")
    : `${item.local_summary} -> ${item.remote_summary}`;
  const conflicts = (item.plugin_conflicts?.length ?? 0) > 0 ? ` · 冲突 ${item.plugin_conflicts?.length} 条` : "";
  const skipped = item.skipped_keys.length > 0 ? ` · 跳过 ${item.skipped_keys.join("、")}` : "";
  const risk = item.high_risk ? " · 高风险" : "";
  return `${action} · ${change}${conflicts}${skipped}${risk}`;
}

function restoreActionLabel(action: string) {
  if (action === "would_update") return "将更新";
  if (action === "would_replace") return "将替换";
  if (action === "unchanged") return "无变化";
  return "需检查";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 bytes";
  return `${Math.round(bytes)} bytes`;
}
