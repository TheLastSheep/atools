#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = join(
  REPO_ROOT,
  'output/plugin-entry-lifecycle/upstream-contract-worker.json',
);
const AUTHORITIES = {
  ztools: {
    root: '/Users/harris/Desktop/ZTools',
    expectedHead: '9b15fb1a2a9f3ec886016632761c7bb21e39557a',
    expectedRemotes: {
      origin: 'https://github.com/ZToolsCenter/ZTools',
    },
  },
  plugins: {
    root: '/Users/harris/Desktop/ZTools-plugins',
    expectedHead: '37e2cd62f9cf807504ed8643a05cb046abf5ca22',
    expectedRemotes: {
      origin: 'git@github.com:TheLastSheep/ZTools-plugins.git',
      upstream: 'https://github.com/ZToolsCenter/ZTools-plugins.git',
    },
  },
};

const PINNED_FILES = {
  ztoolsPreload: {
    authority: 'ztools',
    path: 'resources/preload.js',
    sha256: '59386348e210b827507477cde9182eabaf534fa0697b813408c9a75c0919e47f',
  },
  ztoolsPluginManager: {
    authority: 'ztools',
    path: 'src/main/managers/pluginManager.ts',
    sha256: '27debfafa1ba9f3e02dc482e532efd16859f23e89258d8caab839fe670fc1626',
  },
  ztoolsAppMain: {
    authority: 'ztools',
    path: 'src/main/appMain.ts',
    sha256: 'db850540f0f4b1d686a3f9b441929bc4b7d202d71e5d6b5cd97899c7df9b037f',
  },
  snipasteManifest: {
    authority: 'plugins',
    path: 'plugins/snipaste/plugin.json',
    sha256: '7394a199e000c0608ffb81bf2bb0fcc19e418d6cac5f3856efc09a81d9c78375',
  },
  snipasteServices: {
    authority: 'plugins',
    path: 'plugins/snipaste/preload/services.cjs',
    sha256: '97b14b5737c45cd3f8c3bad61c3e09cb87f843c4465dc1127803e9e098e47a58',
  },
  pasteManifest: {
    authority: 'plugins',
    path: 'plugins/pasteboard-pro/plugin.json',
    sha256: '58e89b2e6b9d3c95711fe5f41852b24e2de32e0c2575c4866eb9fc1cc9e62ae8',
  },
  pasteZtoolsManifest: {
    authority: 'plugins',
    path: 'plugins/pasteboard-pro/apps/ztools/public/plugin.json',
    sha256: '58e89b2e6b9d3c95711fe5f41852b24e2de32e0c2575c4866eb9fc1cc9e62ae8',
  },
  pasteAutoStart: {
    authority: 'plugins',
    path: 'plugins/pasteboard-pro/apps/ztools/preload/auto-start.ts',
    sha256: 'af88f84731177bfc12d84ca2fc401d9161ed2840e7589860ffcc4be67e8a7e18',
  },
  pastePreload: {
    authority: 'plugins',
    path: 'plugins/pasteboard-pro/apps/ztools/preload/index.ts',
    sha256: 'abcc6ab5111a6d72c47035db9fe534c94ec0bb6ee77ed7c516ae3911a485cec6',
  },
};

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceLevel: 'static-source-contract-only',
  businessAcceptance: false,
  runtimeExecuted: false,
  toolchain: { node: process.version, executable: process.execPath },
  authorities: {},
  files: {},
  checks: [],
  errors: [],
  limitations: [
    '该报告只证明固定本地源码满足静态合同，不证明应用运行、权限、后台负载或用户业务验收。',
    '不读取或输出打包/minified bundle；只保存少量目标函数及manifest配置行。',
  ],
};

const sources = new Map();

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message) {
  report.errors.push(message);
}

function recordCheck(id, passed, details, source) {
  const check = { id, passed: Boolean(passed), details };
  if (source) check.source = source;
  report.checks.push(check);
  if (!check.passed) fail(`${id}: ${details}`);
  return check.passed;
}

function captureAuthority(name, authority) {
  const item = {
    root: authority.root,
    expectedHead: authority.expectedHead,
    expectedRemotes: authority.expectedRemotes,
  };
  report.authorities[name] = item;
  try {
    item.realPath = realpathSync(authority.root);
    item.head = git(authority.root, ['rev-parse', 'HEAD']);
    item.remotes = {};
    const remoteLines = git(authority.root, ['remote', '-v']).split('\n');
    for (const line of remoteLines) {
      const match = line.match(/^([^\s]+)\s+(.+?)\s+\((fetch|push)\)$/);
      if (!match) continue;
      item.remotes[match[1]] ??= {};
      item.remotes[match[1]][match[3]] = match[2];
    }
    const authorityPaths = Object.values(PINNED_FILES)
      .filter((file) => file.authority === name)
      .map((file) => file.path);
    item.relevantWorkingTreeStatus = git(authority.root, [
      'status',
      '--short',
      '--untracked-files=normal',
      '--',
      ...authorityPaths,
    ]);
    recordCheck(
      `${name}.head`,
      item.head === authority.expectedHead,
      `HEAD=${item.head}; expected ${authority.expectedHead}`,
    );
    for (const [remote, expectedUrl] of Object.entries(authority.expectedRemotes)) {
      for (const direction of ['fetch', 'push']) {
        const actual = item.remotes[remote]?.[direction];
        recordCheck(
          `${name}.remote.${remote}.${direction}`,
          actual === expectedUrl,
          `${direction} remote=${actual ?? 'missing'}; expected ${expectedUrl}`,
        );
      }
    }
  } catch (error) {
    item.error = String(error);
    fail(`${name} authority unavailable: ${String(error)}`);
  }
}

function loadPinnedSources() {
  for (const [key, pin] of Object.entries(PINNED_FILES)) {
    const authority = AUTHORITIES[pin.authority];
    const absolutePath = join(authority.root, pin.path);
    try {
      const text = readFileSync(absolutePath, 'utf8');
      const actualHash = sha256(text);
      const sourceInfo = {
        authority: pin.authority,
        path: absolutePath,
        sha256: actualHash,
        expectedSha256: pin.sha256,
      };
      report.files[key] = sourceInfo;
      sources.set(key, { text, sourceInfo });
      recordCheck(
        `source.${key}.sha256`,
        actualHash === pin.sha256,
        `sha256=${actualHash}; expected ${pin.sha256}`,
        sourceInfo,
      );
    } catch (error) {
      fail(`source ${key} unavailable at ${absolutePath}: ${String(error)}`);
    }
  }
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function sourceExcerpt(info, source, start, end) {
  const lines = source.slice(start, end).split('\n');
  return {
    path: info.path,
    sha256: info.sha256,
    lineStart: lineNumber(source, start),
    lineEnd: lineNumber(source, end),
    excerpt: lines.join('\n').slice(0, 5000),
  };
}

function extractBraceBlock(source, openingBrace) {
  if (source[openingBrace] !== '{') throw new Error('opening brace not found');
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return { start: openingBrace, end: index + 1 };
    }
  }
  throw new Error('unterminated source block');
}

function blockAfter(source, marker) {
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error(`source marker missing: ${marker}`);
  const openingBrace = source.indexOf('{', markerAt + marker.length);
  if (openingBrace < 0) throw new Error(`block opening missing after: ${marker}`);
  return extractBraceBlock(source, openingBrace);
}

function addExcerpt(name, key, block) {
  const entry = sources.get(key);
  const excerpt = sourceExcerpt(entry.sourceInfo, entry.text, block.start, block.end);
  report.files[name] = excerpt;
  return entry.text.slice(block.start, block.end);
}

function withSource(key, callback) {
  const item = sources.get(key);
  if (!item) return;
  callback(item.text, item.sourceInfo);
}

function checkZToolsContracts() {
  withSource('ztoolsPreload', (source, info) => {
    for (const name of ['onPluginEnter', 'onPluginReady']) {
      const block = blockAfter(source, `${name}: async (callback) =>`);
      const body = addExcerpt(`ztools.${name}`, 'ztoolsPreload', block);
      recordCheck(
        `lifecycle.${name}.usesEnterCallback`,
        body.includes('enterCallback = callback') &&
          body.includes('replayPendingPluginEnterIfNeeded()'),
        `${name} assigns the shared enterCallback and replays the pending PluginEnter payload`,
        report.files[`ztools.${name}`],
      );
    }
    const enterBody = report.files['ztools.onPluginEnter'].excerpt;
    const readyBody = report.files['ztools.onPluginReady'].excerpt;
    recordCheck(
      'lifecycle.readyAliasesEnter',
      enterBody.includes('enterCallback = callback') &&
        readyBody.includes('enterCallback = callback'),
      'onPluginEnter and legacy onPluginReady write the identical enterCallback slot',
    );
  });

  withSource('ztoolsPluginManager', (source) => {
    const block = blockAfter(source, 'public async preloadPlugin(pluginPath: string)');
    const body = addExcerpt('ztools.preloadPlugin', 'ztoolsPluginManager', block);
    recordCheck(
      'background.preload.loadsPluginUrl',
      body.includes('view.webContents.loadURL(pluginUrl)'),
      'preloadPlugin loads the resolved plugin URL',
      report.files['ztools.preloadPlugin'],
    );
    recordCheck(
      'background.preload.doesNotDispatchEnter',
      !body.includes('dispatchLifecycleEvent') && !body.includes('processPluginMode'),
      'preloadPlugin block has no direct dispatchLifecycleEvent or processPluginMode call',
      report.files['ztools.preloadPlugin'],
    );
  });

  withSource('ztoolsAppMain', (source, info) => {
    const marker = "const autoStartPlugins = api.dbGet('auto-start-plugin')";
    const markerAt = source.indexOf(marker);
    const preloadAt = source.indexOf('pluginManager.preloadPlugin(plugin.path)', markerAt);
    const dispatchAt = source.indexOf('dispatchLifecycleEvent', markerAt);
    const start = source.lastIndexOf('\n', markerAt) + 1;
    const endLine = source.indexOf('\n', source.indexOf('\n', preloadAt) + 1);
    const snippet = sourceExcerpt(info, source, start, endLine < 0 ? source.length : endLine);
    report.files.ztoolsAutoStartLoop = snippet;
    recordCheck(
      'background.launchReadsKeyAndPreloads',
      markerAt >= 0 && preloadAt >= markerAt &&
        (dispatchAt < 0 || dispatchAt > preloadAt),
      'app startup reads auto-start-plugin and calls preloadPlugin for resolved enabled plugins',
      snippet,
    );
  });
}

function manifestSetting(key, label) {
  const entry = sources.get(key);
  if (!entry) return;
  try {
    const manifest = JSON.parse(entry.text);
    const markerAt = entry.text.indexOf('"backgroundRunning"');
    const start = Math.max(0, entry.text.lastIndexOf('\n', markerAt - 1) + 1);
    const end = entry.text.indexOf('\n', entry.text.indexOf('\n', markerAt) + 1);
    const snippet = sourceExcerpt(
      entry.sourceInfo,
      entry.text,
      start,
      end < 0 ? entry.text.length : end,
    );
    report.files[`${label}ManifestSetting`] = snippet;
    recordCheck(
      `${label}.backgroundRunningTrue`,
      manifest.pluginSetting?.backgroundRunning === true,
      `${label} manifest pluginSetting.backgroundRunning is true`,
      snippet,
    );
  } catch (error) {
    recordCheck(`${label}.manifestJson`, false, `manifest parse failed: ${String(error)}`);
  }
}

function checkPluginContracts() {
  manifestSetting('snipasteManifest', 'snipaste');
  manifestSetting('pasteManifest', 'paste');
  manifestSetting('pasteZtoolsManifest', 'pasteZtools');
  withSource('pasteManifest', (source) => {
    const pasteManifest = JSON.parse(source);
    const ztoolsEntry = sources.get('pasteZtoolsManifest');
    const same = Boolean(ztoolsEntry) &&
      sha256(source) === ztoolsEntry.sourceInfo.sha256 &&
      pasteManifest.pluginSetting?.backgroundRunning === true;
    recordCheck(
      'paste.packageManifestsMatch',
      same,
      'root and apps/ztools public manifests have the same pinned source and backgroundRunning setting',
    );
  });

  withSource('snipasteServices', (source) => {
    const block = blockAfter(source, 'async function ensureAutoStartPlugin()');
    const body = addExcerpt('snipaste.ensureAutoStartPlugin', 'snipasteServices', block);
    const keyDeclaration = source.includes('const AUTO_START_DB_KEY = "auto-start-plugin";');
    recordCheck(
      'snipaste.autoStartReadsAndRegisters',
      keyDeclaration && body.includes('ipc.invoke("ztools:db-get", AUTO_START_DB_KEY)') &&
        body.includes('ipc.invoke("ztools:db-put", AUTO_START_DB_KEY'),
      'ensureAutoStartPlugin reads and idempotently writes auto-start-plugin via ZTools db IPC',
      report.files['snipaste.ensureAutoStartPlugin'],
    );
    const callMarker = 'ensureAutoStartPlugin().catch(() => {})';
    const callAt = source.indexOf(callMarker);
    const callExcerpt = sourceExcerpt(
      sources.get('snipasteServices').sourceInfo,
      source,
      Math.max(0, source.lastIndexOf('\n', callAt - 1) + 1),
      source.indexOf('\n', callAt) < 0 ? source.length : source.indexOf('\n', callAt),
    );
    report.files.snipasteAutoStartCall = callExcerpt;
    recordCheck(
      'snipaste.autoStartInvokedAtPreload',
      callAt >= 0,
      'services preload invokes ensureAutoStartPlugin during window bridge installation',
      callExcerpt,
    );
  });

  withSource('pasteAutoStart', (source) => {
    const block = blockAfter(source, 'export async function ensureZToolsAutoStart(');
    const body = addExcerpt('paste.ensureZToolsAutoStart', 'pasteAutoStart', block);
    const keyDeclaration = source.includes('const AUTO_START_STORAGE_KEY = "auto-start-plugin";');
    recordCheck(
      'paste.autoStartReadsAndRegisters',
      keyDeclaration && body.includes('ipc.invoke("ztools:db-get", AUTO_START_STORAGE_KEY)') &&
        body.includes('ipc.invoke("ztools:db-put", AUTO_START_STORAGE_KEY'),
      'ensureZToolsAutoStart reads and idempotently writes auto-start-plugin via ZTools db IPC',
      report.files['paste.ensureZToolsAutoStart'],
    );
  });

  withSource('pastePreload', (source, info) => {
    const marker = 'if (ownsClipboardHistoryMirror(windowRole))';
    const block = blockAfter(source, marker);
    const body = addExcerpt('paste.primaryPreload', 'pastePreload', block);
    recordCheck(
      'paste.autoStartInvokedForPrimary',
      body.includes('ensureZToolsAutoStart(ipcRenderer)'),
      'the primary clipboard-history preload path invokes ensureZToolsAutoStart',
      report.files['paste.primaryPreload'],
    );
  });
}

for (const [name, authority] of Object.entries(AUTHORITIES)) {
  captureAuthority(name, authority);
}
loadPinnedSources();
checkZToolsContracts();
checkPluginContracts();

report.status = report.errors.length === 0 ? 'PASS_STATIC_CONTRACTS' : 'FAIL';
report.summary = {
  passedChecks: report.checks.filter((check) => check.passed).length,
  failedChecks: report.checks.filter((check) => !check.passed).length,
  errorCount: report.errors.length,
};

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `background-contract-audit ${report.status} checks=${report.summary.passedChecks}/${report.checks.length} ` +
  `errors=${report.errors.length} report=${REPORT_PATH}`,
);
if (report.errors.length > 0) {
  for (const error of report.errors) console.error(`FAIL ${error}`);
  process.exitCode = 1;
}
