export type PluginBridgeCapabilityStatus = "ready" | "partial";

export type PluginBridgeCapabilityGroup = {
  id: "data" | "events" | "clipboard" | "input" | "dialog" | "window" | "system" | "user" | "context";
  label: string;
  status: PluginBridgeCapabilityStatus;
  methods: string[];
};

const BRIDGE_CAPABILITY_GROUPS: PluginBridgeCapabilityGroup[] = [
  {
    id: "data",
    label: "DB",
    status: "ready",
    methods: [
      "db.put",
      "db.get",
      "db.remove",
      "db.allDocs",
      "db.bulkDocs",
      "db.putAttachment",
      "db.getAttachment",
      "db.getAttachmentType",
      "db.replicateStateFromCloud",
      "dbStorage.setItem",
      "dbStorage.getItem",
      "dbStorage.removeItem",
      "onDbPull",
    ],
  },
  {
    id: "events",
    label: "事件",
    status: "partial",
    methods: ["onPluginEnter", "onPluginReady", "onPluginOut", "onPluginDetach", "onMainPush"],
  },
  {
    id: "clipboard",
    label: "剪贴板",
    status: "partial",
    methods: [
      "copyText",
      "clipboard.getHistory/getContent (text/image/file entries; ClipboardRead)",
      "clipboard.delete/clear (text/image/file history; ClipboardDelete)",
      "clipboard.write/writeContent (permissioned-host text/HTML/image/file copy/paste; HTML history unsupported; PNG writes capped at 512 KiB, image paths use bounded file reads)",
      "clipboard.search (bounded text/image/file history)",
      "clipboard.onChange (text/image/file history); HTML history unsupported",
      "copyFile",
      "copyImage",
      "getCopyedFiles",
      "getCopiedFiles",
    ],
  },
  {
    id: "input",
    label: "输入",
    status: "partial",
    methods: [
      "hideMainWindowPasteText",
      "hideMainWindowPasteImage",
      "hideMainWindowPasteFile",
      "hideMainWindowTypeString",
    ],
  },
  {
    id: "dialog",
    label: "对话框",
    status: "partial",
    methods: ["showOpenDialog", "showSaveDialog"],
  },
  {
    id: "window",
    label: "窗口",
    status: "partial",
    methods: [
      "hideMainWindow",
      "showMainWindow",
      "getWindowType",
      "findInPage",
      "stopFindInPage",
      "setExpendHeight",
      "setExpandHeight",
      "setSubInput",
      "setSubInputValue",
      "removeSubInput",
      "subInputFocus",
      "subInputBlur",
      "subInputSelect",
      "startDrag",
      "isDarkColors",
      "redirect",
      "redirectHotKeySetting",
      "redirectAiModelsSetting",
      "createBrowserWindow",
      "sendToParent",
      "getWebContentsId",
    ],
  },
  {
    id: "system",
    label: "系统",
    status: "ready",
    methods: [
      "system_get_path",
      "getPath",
      "getNativeId",
      "getAppName",
      "getAppVersion",
      "isDev",
      "isMacOS",
      "isWindows",
      "isLinux",
      "getFileIcon",
      "shellOpenExternal",
      "shellOpenPath",
      "shellShowItemInFolder",
      "shellTrashItem",
      "shellBeep",
    ],
  },
  {
    id: "user",
    label: "用户",
    status: "partial",
    methods: ["getUser", "fetchUserServerTemporaryToken"],
  },
  {
    id: "context",
    label: "上下文",
    status: "partial",
    methods: [
      "screenCapture",
      "screenColorPick",
      "getPrimaryDisplay",
      "getAllDisplays",
      "getCursorScreenPoint",
      "getDisplayNearestPoint",
      "getDisplayMatching",
      "screenToDipPoint",
      "dipToScreenPoint",
      "screenToDipRect",
      "dipToScreenRect",
      "desktopCaptureSources",
      "readCurrentBrowserUrl",
      "getCurrentBrowserUrl",
      "readCurrentFolderPath",
    ],
  },
];

export function pluginBridgeCapabilityGroups(): PluginBridgeCapabilityGroup[] {
  return BRIDGE_CAPABILITY_GROUPS.map((group) => ({
    ...group,
    methods: [...group.methods],
  }));
}

export function pluginBridgeRuntimeDetail(): string {
  return BRIDGE_CAPABILITY_GROUPS.map((group) => group.label).join(" / ");
}
