import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mod = await import("../src/lib/pasteboardSyncView.ts");

assert.deepEqual(
  mod.pasteboardSyncPresentation({
    ...mod.DEFAULT_PASTEBOARD_SYNC_SETTINGS,
    state: "wrong_password",
  }),
  {
    label: "需要重新验证",
    detail: "检查 WebDAV 或剪贴板同步密码",
    tone: "error",
    action: "unlock",
  },
);
assert.equal(
  mod.pasteboardSyncPresentation({
    ...mod.DEFAULT_PASTEBOARD_SYNC_SETTINGS,
    state: "offline",
    pendingObjects: 4,
  }).action,
  "retry",
);
assert.equal(
  mod.derivePasteboardVaultUrl(
    "https://dav.example.com/remote.php/dav/files/alice/",
    "/ATools",
  ),
  "https://dav.example.com/remote.php/dav/files/alice/ATools/PasteboardPro/v1/",
);
assert.equal(
  mod.derivePasteboardVaultUrl("http://dav.example.com/", "/ATools"),
  "",
);
assert.equal(mod.derivePasteboardVaultUrl("not a URL", "/ATools"), "");
assert.equal(mod.derivePasteboardVaultUrl("https://dav.example.com/", "/../escape"), "");
assert.equal(
  mod.derivePasteboardVaultUrl("https://dav.example.com/alice%20vault/", "/ATools Data"),
  "https://dav.example.com/alice%20vault/ATools%20Data/PasteboardPro/v1/",
);
assert.equal(
  mod.pasteboardSettingsContainSecret(mod.DEFAULT_PASTEBOARD_SYNC_SETTINGS),
  false,
);

const settingsPanel = await readFile(
  new URL("../src/components/SettingsPanel.svelte", import.meta.url),
  "utf8",
);
assert.match(settingsPanel, /pasteboardWebdavPassword = "";\s+pasteboardSyncPassword = "";/);
assert.ok(
  settingsPanel.indexOf('pasteboardWebdavPassword = "";') <
    settingsPanel.indexOf('invoke<PasteboardSyncSettings>("configure_pasteboard_sync"'),
  "one-shot password fields must be cleared before invoking native configuration",
);
assert.doesNotMatch(
  settingsPanel.match(/pasteboardSyncSettings = \$state[\s\S]*?\);/)?.[0] ?? "",
  /password|secret/i,
);

console.log("PasteboardPro sync view verified");
