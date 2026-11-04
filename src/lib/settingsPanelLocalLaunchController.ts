import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createLocalLaunchEntry,
  DEFAULT_LOCAL_LAUNCH_ENTRIES,
  dispatchLocalLaunchEntries,
  localLaunchOverviewCards,
  resolveLocalLaunchPath,
  saveLocalLaunchEntries,
  type LocalLaunchEntry,
  type LocalLaunchKind,
} from "./localLaunch";
import { callHumanCapability, hasTauriRuntime, safeHomePath } from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";

export function createSettingsLocalLaunchController(
  s: SettingsPanelState,
  deps: {
    confirmSettingsAction: (options: {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: "default" | "danger";
    }) => Promise<boolean>;
  },
) {
  const { confirmSettingsAction } = deps;

  function localLaunchOverview() {
    return localLaunchOverviewCards({
      entries: s.localLaunchEntries,
      statusLabel: s.localLaunchStatus,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function persistLocalLaunchEntries(entries: LocalLaunchEntry[], status: string) {
    s.localLaunchEntries = entries;
    saveLocalLaunchEntries(entries);
    dispatchLocalLaunchEntries(entries);
    s.localLaunchStatus = status;
  }

  function addLocalLaunchEntry() {
    const existingKeywords = new Set(s.localLaunchEntries.map((entry) => entry.keyword));
    const next = createLocalLaunchEntry();
    let suffix = 1;
    while (existingKeywords.has(next.keyword)) {
      suffix += 1;
      next.keyword = `local${suffix}`;
    }
    persistLocalLaunchEntries([...s.localLaunchEntries, next], "已添加本地启动项");
  }

  function selectedLocalLaunchPath(value: string | string[] | null): string {
    if (Array.isArray(value)) return value[0] ?? "";
    return value ?? "";
  }

  function inferLocalLaunchName(path: string) {
    const trimmed = path.trim().replace(/\/+$/, "");
    const name = trimmed.split("/").filter(Boolean).at(-1) ?? "本地启动项";
    return name.replace(/\.app$/i, "") || "本地启动项";
  }

  function inferLocalLaunchKeyword(name: string) {
    const ascii = name
      .toLowerCase()
      .replace(/\.app$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return ascii || "local";
  }

  function uniqueLocalLaunchKeyword(keyword: string) {
    const existingKeywords = new Set(s.localLaunchEntries.map((entry) => entry.keyword.toLowerCase()));
    let candidate = keyword;
    let suffix = 1;
    while (existingKeywords.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${keyword}${suffix}`;
    }
    return candidate;
  }

  function inferLocalLaunchKindFromPath(path: string, fallback: LocalLaunchKind): LocalLaunchKind {
    if (/\.app\/?$/i.test(path)) return "app";
    return fallback;
  }

  function createLocalLaunchEntryFromPath(path: string, kind: LocalLaunchKind): LocalLaunchEntry {
    const name = inferLocalLaunchName(path);
    const keyword = uniqueLocalLaunchKeyword(inferLocalLaunchKeyword(name));
    return {
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      keyword,
      path,
      kind: inferLocalLaunchKindFromPath(path, kind),
      enabled: true,
    };
  }

  async function addLocalLaunchEntryFromPicker(kind: LocalLaunchKind) {
    s.localLaunchStatus = "";
    if (!hasTauriRuntime()) {
      s.localLaunchStatus = "浏览器预览模式无法选择本地路径";
      return;
    }
    try {
      const selected = await openDialog({
        directory: kind !== "file",
        multiple: false,
        title: kind === "folder" ? "选择文件夹" : kind === "app" ? "选择应用" : "选择文件",
      });
      const path = selectedLocalLaunchPath(selected);
      if (!path) {
        s.localLaunchStatus = "已取消选择";
        return;
      }
      const entry = createLocalLaunchEntryFromPath(path, kind);
      persistLocalLaunchEntries([...s.localLaunchEntries, entry], `已添加 ${entry.name}`);
    } catch (error) {
      s.localLaunchStatus = String(error);
    }
  }

  function updateLocalLaunchEntry(id: string, patch: Partial<LocalLaunchEntry>) {
    persistLocalLaunchEntries(
      s.localLaunchEntries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存本地启动项",
    );
  }

  async function removeLocalLaunchEntry(entry: LocalLaunchEntry) {
    if (!await confirmSettingsAction({
      title: "删除本地启动项",
      message: `确定要删除“${entry.name}”吗？删除后主搜索将不再匹配这个路径。`,
      confirmLabel: "删除",
    })) return;
    persistLocalLaunchEntries(
      s.localLaunchEntries.filter((item) => item.id !== entry.id),
      "已删除本地启动项",
    );
  }

  function resetLocalLaunchEntries() {
    persistLocalLaunchEntries(DEFAULT_LOCAL_LAUNCH_ENTRIES.map((entry) => ({ ...entry })), "已恢复默认本地启动项");
  }

  async function localLaunchResolvedPath(entry: LocalLaunchEntry) {
    const homePath = hasTauriRuntime() ? await safeHomePath() : "";
    return resolveLocalLaunchPath(entry.path, homePath);
  }

  async function openLocalLaunchPath(entry: LocalLaunchEntry) {
    const resolvedPath = await localLaunchResolvedPath(entry);
    if (!hasTauriRuntime()) {
      s.localLaunchStatus = `浏览器预览模式无法打开：${resolvedPath}`;
      return;
    }
    try {
      await callHumanCapability("open_or_reveal_path", { path: resolvedPath, reveal: false });
      s.localLaunchStatus = `已打开 ${entry.name}`;
    } catch (error) {
      s.localLaunchStatus = String(error);
    }
  }

  async function revealLocalLaunchPath(entry: LocalLaunchEntry) {
    const resolvedPath = await localLaunchResolvedPath(entry);
    if (!hasTauriRuntime()) {
      s.localLaunchStatus = `浏览器预览模式无法定位：${resolvedPath}`;
      return;
    }
    try {
      await callHumanCapability("open_or_reveal_path", { path: resolvedPath, reveal: true });
      s.localLaunchStatus = `已定位 ${entry.name}`;
    } catch (error) {
      s.localLaunchStatus = String(error);
    }
  }

  function onLocalLaunchDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function droppedLocalLaunchPath(file: File) {
    const nativeFile = file as File & { path?: string };
    return nativeFile.path || file.webkitRelativePath || file.name;
  }

  function looksLikeLocalPath(path: string) {
    return path.startsWith("/") || path.startsWith("~/");
  }

  async function onLocalLaunchDrop(event: DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    const entries = files
      .map((file) => {
        const path = droppedLocalLaunchPath(file);
        if (!path || !looksLikeLocalPath(path)) return null;
        return createLocalLaunchEntryFromPath(path, inferLocalLaunchKindFromPath(path, "file"));
      })
      .filter((entry): entry is LocalLaunchEntry => entry !== null);

    if (entries.length === 0) {
      s.localLaunchStatus = "拖拽添加需要桌面端提供本地路径";
      return;
    }
    persistLocalLaunchEntries([...s.localLaunchEntries, ...entries], `已拖拽添加 ${entries.length} 个启动项`);
  }

  return {
    localLaunchOverview,
    persistLocalLaunchEntries,
    addLocalLaunchEntry,
    selectedLocalLaunchPath,
    inferLocalLaunchName,
    inferLocalLaunchKeyword,
    uniqueLocalLaunchKeyword,
    inferLocalLaunchKindFromPath,
    createLocalLaunchEntryFromPath,
    addLocalLaunchEntryFromPicker,
    updateLocalLaunchEntry,
    removeLocalLaunchEntry,
    resetLocalLaunchEntries,
    localLaunchResolvedPath,
    openLocalLaunchPath,
    revealLocalLaunchPath,
    onLocalLaunchDragOver,
    droppedLocalLaunchPath,
    looksLikeLocalPath,
    onLocalLaunchDrop,
  };
}
