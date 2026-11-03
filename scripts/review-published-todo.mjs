#!/usr/bin/env node
// Reproducible, non-executing source review for the pinned todo-neo package.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVerifiedPublishedPluginFixture, sha256 } from './lib/published-plugin-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_ID = 'todo-neo';
const EXPECTED_VERSION = '0.0.1';
const EXPECTED_ARCHIVE_SHA256 = '80a343d4e5abcc4b442c39c49b9c45699999dc7402fe1ebb8d028920e27e143f';
const DEFAULT_COHORT = 'output/legacy-node-2026-10-15/published-review-cohort.json';
const DEFAULT_OUTPUT = 'output/legacy-node-2026-10-15/published-todo-source-review.json';

function evidence(source, terms, radius = 190, limit = 3) {
  const rows = [];
  for (const term of terms) {
    let cursor = 0, found = 0;
    while (found < limit) {
      const offset = source.indexOf(term, cursor);
      if (offset < 0) break;
      rows.push({ term, offsetCodeUnits: offset,
        excerpt: source.slice(Math.max(0, offset - radius), Math.min(source.length, offset + term.length + radius)) });
      cursor = offset + Math.max(1, term.length); found += 1;
    }
  }
  return rows;
}

function required(files, name, encoding = 'utf8') {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Pinned package omitted required review source: ${name}`);
  return encoding === null ? bytes : bytes.toString(encoding);
}

function fileRecord(name, bytes, role) {
  return { path: name, bytes: bytes.length, sha256: sha256(bytes), role };
}

function cli(argv) {
  const result = { cohort: DEFAULT_COHORT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cohort' && argv[i + 1]) result.cohort = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) result.output = argv[++i];
    else throw new Error('Usage: node scripts/review-published-todo.mjs [--cohort PATH] [--output PATH]');
  }
  return result;
}

export async function reviewPublishedTodo({ cohortPath, outputPath }) {
  const cohortBytes = await readFile(cohortPath);
  const cohort = JSON.parse(cohortBytes.toString('utf8'));
  if (cohort.status !== 'captured_pending_source_review' || cohort.scope?.pluginCodeExecuted !== false) {
    throw new Error('Input cohort is not the expected non-executing captured review cohort');
  }
  const matches = cohort.candidates?.filter(row => row.id === EXPECTED_ID) ?? [];
  if (matches.length !== 1) throw new Error('Input cohort must contain exactly one todo-neo candidate');
  const row = matches[0];
  if (row.status !== 'captured_pending_source_review' || row.fixture?.id !== EXPECTED_ID
    || row.fixture?.version !== EXPECTED_VERSION || row.archive?.locallyComputedSha256 !== EXPECTED_ARCHIVE_SHA256
    || row.fixture?.archiveSha256 !== EXPECTED_ARCHIVE_SHA256) {
    throw new Error('todo-neo fixture identity/version/archive pin does not match this review');
  }

  // Verify one bounded ZIP buffer and all extracted file bytes through the fixture API.
  // Never trust or reopen a same-UID-editable contentRoot path as source evidence.
  const verified = await readVerifiedPublishedPluginFixture(row.fixture, EXPECTED_ARCHIVE_SHA256);
  const files = verified.files;
  const manifestText = required(files, 'plugin.json');
  const manifest = JSON.parse(manifestText);
  const preload = required(files, 'preload/services.js');
  const html = required(files, 'index.html');
  const bundle = required(files, 'assets/index-DGurGXd_.js');
  const css = required(files, 'assets/index-ClLanyH4.css', null);
  const preloadPackage = required(files, 'preload/package.json');
  if (manifest.name !== EXPECTED_ID || manifest.version !== EXPECTED_VERSION
    || manifest.main !== 'index.html' || manifest.preload !== 'preload/services.js'
    || !Array.isArray(manifest.features)) throw new Error('Pinned package manifest identity/entry contract mismatch');

  const roles = new Map([
    ['README.md', 'Published package documentation; not runtime code'],
    ['index.html', 'HTML main entry; loads the published JS module and stylesheet'],
    ['logo.png', 'Static plugin icon'],
    ['plugin.json', 'Manifest, feature triggers, platform claim, and tool schemas'],
    ['assets/index-ClLanyH4.css', 'Published UI stylesheet'],
    ['preload/package.json', 'Declares CommonJS interpretation for preload directory'],
    ['assets/index-DGurGXd_.js', 'Minified published Vue UI and application behavior bundle'],
    ['preload/services.js', 'CommonJS ZTools capability bridge and tool implementations']
  ]);
  const filesReviewed = [...files.entries()].map(([name, bytes]) => fileRecord(name, bytes, roles.get(name) ?? 'Unclassified package file'));
  const tools = Object.entries(manifest.tools ?? {}).map(([name, tool]) => ({
    name, title: tool.title ?? null, description: tool.description ?? null,
    required: tool.inputSchema?.required ?? [],
    inputProperties: Object.keys(tool.inputSchema?.properties ?? {})
  }));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: 'Pinned published source inspection only; no original plugin code was loaded or executed.',
    source: {
      cohortPath: path.relative(ROOT, cohortPath), cohortSha256: sha256(cohortBytes),
      candidateId: EXPECTED_ID, version: EXPECTED_VERSION,
      archiveUrl: row.archive.url, archiveBytes: row.archive.bytes,
      expectedArchiveSha256: EXPECTED_ARCHIVE_SHA256,
      verifiedArchiveSha256: verified.verification.archiveSha256,
      archivePinMatched: verified.verification.archiveSha256 === EXPECTED_ARCHIVE_SHA256,
      signatureVerified: row.archive.publisherSignatureVerified === true,
      upstreamChecksumVerified: row.archive.upstreamChecksumVerified === true,
      extractedFileCount: verified.verification.unchangedFileCount,
      extractedBytesUnchanged: verified.verification.sourceBytesUnchanged,
      inputFixtureRoot: row.fixture.ownedRoot
    },
    execution: {
      pluginCodeExecuted: false, installed: false, built: false, dependenciesInstalled: false,
      browserOpened: false, newPackageDownloaded: false,
      sourceReadMethod: 'readVerifiedPublishedPluginFixture: one SHA-pinned archive Buffer; package files read from the verified in-memory Map',
      caveat: 'Static excerpts establish the shown source behavior only. Unmatched literals do not prove an operation is absent; runtime behavior remains unverified.'
    },
    package: {
      name: manifest.name, title: manifest.title, pluginName: manifest.pluginName,
      description: manifest.description, author: manifest.author, version: manifest.version,
      aiDeclared: manifest.ai ?? null, platformsDeclared: manifest.platform ?? null,
      main: manifest.main, preload: manifest.preload, preloadModuleType: JSON.parse(preloadPackage).type ?? null,
      htmlEntry: { path: 'index.html', sha256: sha256(required(files, 'index.html', null)),
        evidence: evidence(html, ['<script type="module"', '<div id="app">'], 70, 2) },
      featureCodes: manifest.features.map(feature => ({
        code: feature.code, explain: feature.explain, commands: feature.cmds
      })),
      tools
    },
    files: filesReviewed,
    behavior: {
      preloadStartup: {
        assessment: 'Top-level preload code reads window.ztools, attempts optional Electron ipcRenderer require, defines handlers, conditionally registers four tools, attempts window-request registration, and assigns window.services.',
        evidence: evidence(preload, ["require('electron')", 'registerTools()', 'registerWindowRequestForwarding()', 'window.services =', 'ztools?.registerTool'], 260, 2)
      },
      storage: {
        assessment: 'Task/group records use db allDocs/get/put/remove with todo-tasks/ and todo-group/ prefixes; sort counters use dbStorage. Bundle has localStorage fallback for browser/development mode.',
        keysAndCalls: evidence(preload, ['TASKS_PREFIX', 'GROUPS_PREFIX', 'NEXT_TASK_SORT_KEY', 'NEXT_GROUP_SORT_KEY', 'allDocs', 'dbStorage', 'db?.put', 'db?.remove'], 180, 2),
        bundleFallbackEvidence: evidence(bundle, ['todo-dev-docs', 'window.ztools.dbStorage.getItem', 'window.ztools.db.allDocs', 'window.ztools.db.put'], 160, 2)
      },
      hostApi: {
        assessment: 'Source references ZTools database/storage, tool registration, lifecycle/db-pull, notification/feature exit, and window APIs. Actual ATools adapter coverage is not established by this source review.',
        preloadEvidence: evidence(preload, ['getWindowType', 'sendToParent', 'createBrowserWindow', 'onPluginEnter', 'onDbPull', 'outPlugin', 'showNotification', 'registerTool', 'setAlwaysOnTop'], 150, 2),
        bundleEvidence: evidence(bundle, ['window.ztools?.onPluginEnter', 'window.ztools?.onDbPull', 'window.ztools?.outPlugin', 'window.ztools?.showNotification'], 170, 2)
      },
      startupAndEffects: {
        assessment: 'Preload registration/exposure occurs at module top level. Main UI lifecycle helper attaches hash/keyboard handlers and calls onPluginEnter/onDbPull, then starts a 1-second interval; matching cleanup removes handlers and clears interval when component references release. This is source behavior; exact host trigger timing is unverified.',
        evidence: evidence(bundle, ['window.ztools?.onPluginEnter?.(pl)', 'window.ztools?.onDbPull?.(()=>ks())', 'window.setInterval(()=>{$s()},1e3)', 'window.clearInterval(Es)', 'function vl(){return sr(()=>{Ts+=1,gl()}'], 210, 2),
        preloadEvidence: evidence(preload, ['registerTools()', 'registerWindowRequestForwarding()', 'window.services ='], 230, 1)
      },
      windows: {
        assessment: 'The current package hardcodes noteWindow and tomatoWindow false. The preload functions early-return under those flags, and todo_pin_to_screen is omitted from registered handlers; window creation APIs are present in source but not reachable through those flag-gated feature paths with these constants.',
        flags: { noteWindow: false, tomatoWindow: false },
        evidence: evidence(preload, ['noteWindow: false', 'tomatoWindow: false', 'if (!FEATURE_FLAGS.noteWindow)', 'if (!FEATURE_FLAGS.tomatoWindow)', 'createBrowserWindow?.'], 175, 2)
      },
      nativeAndProcess: {
        assessment: 'Preload statically imports only Electron ipcRenderer in a try/catch. No child_process, native addon, or process-launch implementation was identified in the reviewed preload or targeted bundle excerpts; this literal/source review cannot establish absence across dynamic or opaque behavior.',
        preloadEvidence: evidence(preload, ["require('electron')", 'ipcRenderer'], 155, 2),
        targetedBundleEvidence: evidence(bundle, ['child_process', 'execSync', 'spawnSync', 'node:child_process'], 90, 1),
        absenceClaim: false
      },
      network: {
        assessment: 'A fetch call appears near the bundle start in shared browser asset-loading code. This review did not establish a Todo-specific network request or exhaustively analyze computed/dynamic network behavior.',
        evidence: evidence(bundle, ['fetch(e.href,n)'], 150, 1),
        preloadNetworkKeywordEvidence: evidence(preload, ['fetch(', 'XMLHttpRequest', 'WebSocket', 'https://'], 100, 1),
        absenceClaim: false
      },
      ai: {
        assessment: 'Manifest declares ai=true. No direct ZTools AI invocation was established from the inspected preload and targeted bundle excerpts; AI user interaction/runtime behavior remains unverified.',
        manifestDeclaration: manifest.ai ?? null,
        evidence: evidence(manifestText, ['"ai": true'], 50, 1).map(item => ({ ...item, offsetCodeUnits: item.offsetCodeUnits })),
        targetedApiEvidence: evidence(preload, ['ztools.ai', 'allAiModels'], 100, 1).concat(evidence(bundle, ['window.ztools.ai', 'allAiModels'], 100, 1)),
        absenceClaim: false
      }
    },
    limitations: [
      'No parser-backed call graph, full dependency analysis, or exhaustive data-flow analysis was performed; bundle excerpts are bounded literal searches into a minified file.',
      'A missing string or call pattern is not evidence that the corresponding behavior is impossible.',
      'Manifest platform declarations are publisher metadata, not cross-platform runtime proof.',
      'The ZIP publisher signature and upstream checksum were not verified.',
      'No host IPC/schema compatibility, UI workflow, persistence, task recovery, windowing, or error behavior was exercised.',
      'No overall plugin compatibility coverage conclusion follows from this single source review.'
    ],
    runtimeAcceptancePlan: {
      status: 'not_run',
      recommendation: 'Only after the host adapter contract is checked, exercise a separately reviewed fixture build in a disposable ATools profile/database with no real user task data. Deny outbound network and browser/window creation for the first pass; explicitly approve any capability added later.',
      scenarios: [
        'Confirm feature discovery for todo (string command “ToDo 待办”) and add (over trigger “添加到待办”), including input payload and result focus behavior.',
        'Read and create tasks/groups, search/filter by text/group/status/due date, mark done and pending, update fields, and verify isolation in disposable storage.',
        'Verify sort counter persistence through dbStorage and data refresh through onDbPull without duplicate tool/lifecycle registration.',
        'Check keyboard handlers and the one-second timer start/cleanup across enter/leave/reopen cycles; measure idle CPU and ensure no duplicate interval.',
        'Verify disabled note/tomato window flags keep window APIs unreachable and expose pin-to-screen as unavailable.',
        'Confirm manifest tools registration support and its schemas through the real ATools adapter before claiming MCP/tool compatibility.',
        'Exercise malformed arguments, missing/deprecated tasks, storage errors, stale state, and app restart recovery; capture TaskRun/audit evidence where supported.'
      ],
      rootExecutionLimits: [
        'Do not execute, install, build, npm-install, or load the original captured ZIP/preload/bundle.',
        'Use reviewed source and a separately prepared test fixture; pin its source hash and inspect the exact files before any runtime test.',
        'Use only disposable profile/database paths and synthetic task contents; never mount the normal user profile or database.',
        'Keep network denied and window creation denied until a separate source-backed need and explicit capability mapping are recorded.',
        'Do not interpret manifest “ai” or platform declarations as proof of working ATools capabilities.'
      ]
    }
  };

  report.implementationSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { outputPath, status: 'reviewed_static_only', archiveSha256: report.source.verifiedArchiveSha256,
    files: files.size, featureCodes: report.package.featureCodes.map(feature => feature.code), tools: tools.length };
}

export async function main(argv = process.argv.slice(2)) {
  const args = cli(argv);
  const cohortPath = path.resolve(ROOT, args.cohort);
  const outputPath = path.resolve(ROOT, args.output);
  if (!cohortPath.startsWith(`${ROOT}${path.sep}`) || !outputPath.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('Cohort and output paths must remain inside the repository');
  }
  console.log(JSON.stringify(await reviewPublishedTodo({ cohortPath, outputPath })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
