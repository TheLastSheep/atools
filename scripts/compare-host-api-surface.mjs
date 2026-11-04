import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const BRIDGE_SOURCE_FILES = [
  "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts",
  "src/lib/pluginUtoolsBridgeSource/utools-api-and-dynamic-features.ts",
  "src/lib/pluginUtoolsBridgeSource/attachments-and-db-storage.ts",
  "src/lib/pluginUtoolsBridgeSource/clipboard-api.ts",
  "src/lib/pluginDataBridge.ts",
  "src/lib/pluginPathsBridge.ts",
  "src/lib/pluginNativeDialogBridge.ts",
  "src/lib/pluginDisplayBridge.ts",
  "src/lib/pluginSecretStorageBridge.ts",
  "src/lib/pluginAiBridge.ts",
  "src/lib/pluginFileDragBridge.ts",
  "crates/atools-plugin/src/node_preload_harness.js",
];

const ELECTRON_SOURCE_FILES = [
  "src/lib/pluginElectronAdapter.ts",
  "crates/atools-plugin/src/node_preload_harness.js",
];

/**
 * Extracts all exported `utools.*` / `ztools.*` and `electron.*` member names implemented by ATools.
 * Inspired by craft-anything's `js_exports_compare`.
 */
export function extractAtoolsHostApiSurface(rootDir = ROOT_DIR) {
  const utoolsMembers = new Set([
    // Lifecycle & core methods injected by bridge factories
    "onPluginEnter",
    "onPluginReady",
    "onPluginOut",
    "onPluginDetach",
    "onMainPush",
    "onDbPull",
    "hideMainWindow",
    "showMainWindow",
    "outPlugin",
    "redirect",
    "setExpendHeight",
    "setExpandHeight",
    "setSubInput",
    "removeSubInput",
    "setSubInputValue",
    "subInputFocus",
    "subInputSelect",
    "subInputBlur",
    "getFeatures",
    "setFeature",
    "setFeatures",
    "removeFeature",
    "showNotification",
    "shellOpenPath",
    "shellShowItemInFolder",
    "shellOpenExternal",
    "shellTrashItem",
    "shellBeep",
    "getNativeId",
    "getAppName",
    "getAppVersion",
    "getPath",
    "getFileIcon",
    "copyFile",
    "copyImage",
    "copyText",
    "getCopyedFiles",
    "readCurrentFolderPath",
    "readCurrentBrowserUrl",
    "getCurrentFolderPath",
    "getCurrentBrowserUrl",
    "showOpenDialog",
    "showSaveDialog",
    "findInPage",
    "stopFindInPage",
    "startDrag",
    "createBrowserWindow",
    "sendToParent",
    "ubrowser",
    "db",
    "dbStorage",
    "dbCryptoStorage",
    "ai",
    "allAiModels",
    "getUser",
    "fetchUserServerTemporaryToken",
    "isDev",
    "isMacOS",
    "isMacOs",
    "isWindows",
    "isLinux",
    "isDarkColors",
    "getPrimaryDisplay",
    "getAllDisplays",
    "getCursorScreenPoint",
    "getDisplayNearestPoint",
    "getDisplayMatching",
    "screenColorPick",
    "screenCapture",
    "desktopCaptureSources",
    "simulateKeyboardTap",
    "simulateMouseMove",
    "simulateMouseClick",
    "simulateMouseDoubleClick",
    "simulateMouseRightClick",
    "hideMainWindowPasteText",
    "hideMainWindowPasteImage",
    "hideMainWindowPasteFile",
    "hideMainWindowTypeString",
    "getWindowType",
  ]);

  for (const relPath of BRIDGE_SOURCE_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const propRegex = /^\s{4,8}([a-zA-Z0-9_$]+)\s*:/gm;
    let match;
    while ((match = propRegex.exec(content)) !== null) {
      const name = match[1];
      if (!name.startsWith("_")) {
        utoolsMembers.add(name);
      }
    }
    const assignRegex = /\b(?:utools|ztools)\.([a-zA-Z0-9_$]+)\s*=/g;
    while ((match = assignRegex.exec(content)) !== null) {
      if (!match[1].startsWith("_")) {
        utoolsMembers.add(match[1]);
      }
    }
  }

  const electronNamespaces = new Set([
    "ipcRenderer",
    "shell",
    "clipboard",
    "nativeImage",
    "webFrame",
    "safeStorage",
    "nativeTheme",
    "desktopCapturer",
    "webUtils",
    "screen",
    "contextBridge",
  ]);

  for (const relPath of ELECTRON_SOURCE_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const nsRegex = /\b(ipcRenderer|shell|clipboard|nativeImage|webFrame|safeStorage|nativeTheme|desktopCapturer|webUtils|screen|contextBridge)\b/g;
    let match;
    while ((match = nsRegex.exec(content)) !== null) {
      electronNamespaces.add(match[1]);
    }
  }

  return {
    utools: Array.from(utoolsMembers).sort(),
    electron: Array.from(electronNamespaces).sort(),
  };
}

/**
 * Scans JS/TS/HTML files in a plugin directory or source string for `utools.<member>`, `ztools.<member>`,
 * and `electron.<namespace>` usages, then diffs against ATools's host API surface.
 */
export function evaluateSourceApiCompatibility(codeText, hostSurface = extractAtoolsHostApiSurface()) {
  const utoolsSet = new Set(hostSurface.utools);
  const electronSet = new Set(hostSurface.electron);

  const demandedUtools = new Set();
  const demandedElectron = new Set();
  const ignoredTokens = new Set(["prototype", "constructor", "toString", "valueOf", "then", "length", "call", "apply", "bind"]);

  const utoolsRegex = /\b(?:window\.)?(?:utools|ztools)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  let match;
  while ((match = utoolsRegex.exec(codeText)) !== null) {
    const prop = match[1];
    if (!ignoredTokens.has(prop) && !prop.startsWith("__")) {
      demandedUtools.add(prop);
    }
  }

  const electronRegex = /\belectron\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  while ((match = electronRegex.exec(codeText)) !== null) {
    const prop = match[1];
    if (!ignoredTokens.has(prop) && !prop.startsWith("__")) {
      demandedElectron.add(prop);
    }
  }

  const coveredUtools = [];
  const missingUtools = [];
  for (const prop of Array.from(demandedUtools).sort()) {
    if (utoolsSet.has(prop)) coveredUtools.push(prop);
    else missingUtools.push(prop);
  }

  const coveredElectron = [];
  const missingElectron = [];
  for (const prop of Array.from(demandedElectron).sort()) {
    if (electronSet.has(prop)) coveredElectron.push(prop);
    else missingElectron.push(prop);
  }

  const totalDemanded = demandedUtools.size + demandedElectron.size;
  const totalCovered = coveredUtools.length + coveredElectron.length;
  const coveragePercent = totalDemanded === 0 ? 100 : Number(((totalCovered / totalDemanded) * 100).toFixed(2));

  return {
    totalDemanded,
    totalCovered,
    coveragePercent,
    utools: {
      covered: coveredUtools,
      missing: missingUtools,
    },
    electron: {
      covered: coveredElectron,
      missing: missingElectron,
    },
  };
}

/**
 * Optional integration with `craft-anything-cli` when installed locally on the developer workstation.
 */
export function probeCraftAnythingCli(targetPath) {
  const probe = spawnSync("craft-anything-cli", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (probe.error || probe.status !== 0) {
    return {
      available: false,
      reason: "craft-anything-cli not found in PATH; using built-in ATools AST/regex surface analyzer",
    };
  }
  const version = (probe.stdout || "").trim();
  if (!targetPath) {
    return { available: true, version };
  }
  const run = spawnSync("craft-anything-cli", ["js_app_map", targetPath], {
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    available: true,
    version,
    exitCode: run.status,
    stdout: (run.stdout || "").slice(0, 4096),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const surface = extractAtoolsHostApiSurface();
  const craftStatus = probeCraftAnythingCli(process.argv[2]);
  console.log(
    JSON.stringify(
      {
        hostSurfaceCounts: {
          utools: surface.utools.length,
          electron: surface.electron.length,
        },
        craftAnythingCli: craftStatus,
      },
      null,
      2,
    ),
  );
}
