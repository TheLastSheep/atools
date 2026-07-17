export type PasteboardSyncState =
  | "disabled"
  | "idle"
  | "syncing"
  | "success"
  | "offline"
  | "auth_required"
  | "wrong_password"
  | "partial"
  | "conflict"
  | "corrupted"
  | "schema_too_new";

export type PasteboardSyncSettings = {
  enabled: boolean;
  vaultUrl: string;
  username: string;
  webdavCredentialRef: string;
  pasteboardSyncKeyRef: string;
  vaultSaltHex?: string | null;
  proxyUrl?: string | null;
  syncFileContents: boolean;
  state: PasteboardSyncState;
  pendingObjects: number;
  lastSyncedAt?: string | null;
};

export const DEFAULT_PASTEBOARD_SYNC_SETTINGS: PasteboardSyncSettings = {
  enabled: false,
  vaultUrl: "",
  username: "",
  webdavCredentialRef: "webdav",
  pasteboardSyncKeyRef: "vault-key",
  vaultSaltHex: null,
  proxyUrl: null,
  syncFileContents: false,
  state: "disabled",
  pendingObjects: 0,
  lastSyncedAt: null,
};

export type PasteboardSyncPresentation = {
  label: string;
  detail: string;
  tone: "neutral" | "progress" | "success" | "warning" | "error";
  action?: "retry" | "unlock" | "upgrade";
};

export function pasteboardSyncPresentation(
  settings: PasteboardSyncSettings,
): PasteboardSyncPresentation {
  switch (settings.state) {
    case "disabled":
      return { label: "加密同步已关闭", detail: "PasteboardPro 历史仅保存在这台 Mac", tone: "neutral" };
    case "idle":
      return { label: "等待首次同步", detail: "凭据和密钥已安全保存到 macOS 钥匙串", tone: "neutral" };
    case "syncing":
      return { label: "正在同步", detail: `还有 ${settings.pendingObjects} 个对象待处理`, tone: "progress" };
    case "success":
      return { label: "已同步", detail: settings.lastSyncedAt ?? "刚刚完成", tone: "success" };
    case "offline":
      return { label: "当前离线", detail: `${settings.pendingObjects} 个对象已排队`, tone: "warning", action: "retry" };
    case "auth_required":
    case "wrong_password":
      return { label: "需要重新验证", detail: "检查 WebDAV 或剪贴板同步密码", tone: "error", action: "unlock" };
    case "partial":
      return { label: "部分内容未同步", detail: `${settings.pendingObjects} 个对象等待重试`, tone: "warning", action: "retry" };
    case "conflict":
      return { label: "远端正在变化", detail: "重新拉取并合并后再试", tone: "warning", action: "retry" };
    case "corrupted":
      return { label: "远端数据损坏", detail: "已停止写入，避免覆盖可恢复数据", tone: "error" };
    case "schema_too_new":
      return { label: "需要更新 ATools", detail: "远端数据来自更高协议版本", tone: "error", action: "upgrade" };
  }
}

export function derivePasteboardVaultUrl(
  webdavUrl: string,
  remotePath: string,
): string {
  let url: URL;
  try {
    url = new URL(webdavUrl.trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.username || url.password || url.search || url.hash) return "";
  const remoteSegments = remotePath.split("/").filter(Boolean);
  if (remoteSegments.some((segment) => segment === "." || segment === "..")) return "";
  const basePath = url.pathname.replace(/\/+$/, "");
  const suffix = [...remoteSegments, "PasteboardPro", "v1"]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `${basePath}/${suffix}/`;
  return url.toString();
}

export function pasteboardSettingsContainSecret(value: unknown): boolean {
  return /webdavPassword|syncPassword|password|secret/i.test(JSON.stringify(value));
}
