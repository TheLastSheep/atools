#!/usr/bin/env node
//! Pinned regex-editor package review and private fixture preparation; never loads plugin code.
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preparePublishedPluginFixture, readVerifiedPublishedPluginFixture, sha256 } from './lib/published-plugin-fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(REPO, 'output/legacy-node-2026-10-15/published-artifact-source-audit.json');
const OUTPUT = path.join(REPO, 'output/legacy-node-2026-10-15/published-regex-editor-source-review.json');
const PIN = 'fee84e6dd54f77651b8cef0c9485a10d71c5fa1e18a9eac897f771f1884b0c49';
const EXPECTED_FILES = ['assets/app.css', 'assets/app.js', 'index.html', 'logo.png', 'plugin.json', 'preload/package.json', 'preload/services.js'];
function evidence(text, filename, needle, limit = 200) {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Pinned review evidence absent: ${filename} ${needle.slice(0, 60)}`);
  return { file: filename, line: text.slice(0, offset).split('\n').length, characterOffset: offset,
    excerpt: text.slice(Math.max(0, offset - 32), offset + Math.min(needle.length + 96, limit)),
    boundary: filename === 'assets/app.js' ? 'Bounded excerpt from minified bundle; offsets refer to original text, not readable source or an AST proof.' : 'Original package text; no code execution.' };
}

export async function reviewRegexEditorFixture(fixture) {
  if (fixture.id !== 'regex-editor' || fixture.version !== '1.0.0' || fixture.archiveSha256 !== PIN) throw new Error('This review is restricted to the pinned regex-editor 1.0.0 ZIP');
  const { verification, files } = await readVerifiedPublishedPluginFixture(fixture, PIN);
  if ([...files.keys()].sort().join('\n') !== EXPECTED_FILES.join('\n')) throw new Error('Pinned seven-file inventory mismatch');
  const [manifestText, html, preload, bundle, css, preloadPackage] = ['plugin.json', 'index.html', 'preload/services.js',
    'assets/app.js', 'assets/app.css', 'preload/package.json'].map((name) => files.get(name).toString('utf8'));
  const manifest = JSON.parse(manifestText);
  const e = (file, needle, limit) => evidence(({ 'plugin.json': manifestText, 'index.html': html,
    'preload/services.js': preload, 'assets/app.js': bundle, 'assets/app.css': css, 'preload/package.json': preloadPackage })[file], file, needle, limit);
  const fileRoles = {
    'plugin.json': 'Declares editor feature, text/over triggers, main/preload, icon and supported platforms. Its schema/development URLs are metadata, not observed startup requests.',
    'index.html': 'Static app mount and deferred ./assets/app.js plus ./assets/app.css; no inline plugin logic.',
    'preload/package.json': 'Only declares type=commonjs; no dependencies or lifecycle scripts.',
    'preload/services.js': 'Readable 34-line preload; requires node:fs/node:path and exposes three filesystem service methods.',
    'assets/app.js': 'Minified bundled Vue UI, local regex parser/explanation/matcher, bundled visualRegex, examples, clipboard and host AI calls. It is not readable original source.',
    'assets/app.css': 'UI/theme CSS; no literal url(...) or @import references found in this pinned file.',
    'logo.png': 'Binary image referenced by manifest/feature; retained and hashed, not decoded or rendered during this review.' };
  const literalRequires = [...preload.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  const finiteSignals = ['child_process', 'node:child_process', 'electron', '.node', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'createServer(', '.listen(', 'eval(', 'new Function'];
  const literalSignalObservations = finiteSignals.map((signal) => ({ signal,
    preloadOccurrences: preload.split(signal).length - 1, frontendBundleOccurrences: bundle.split(signal).length - 1,
    boundary: 'Literal substring inventory only; absence cannot rule out computed properties, encoded strings, indirect host APIs or runtime behavior.' }));
  return { verification, evidenceSource: 'One SHA-pinned, CRC-verified ZIP buffer snapshot; source paths are not reopened after filesystem verification.',
    files: [...files].map(([filename, bytes]) => ({ path: filename, bytes: bytes.length, sha256: sha256(bytes),
      verifiedUnchanged: true, role: fileRoles[filename], evidenceSource: 'pinned_zip_buffer_snapshot' })),
    entry: { featureCode: manifest.features[0].code, main: manifest.main, preload: manifest.preload,
      triggerData: manifest.features[0].cmds, platform: manifest.platform,
      evidence: [e('plugin.json', '"code": "editor"'), e('index.html', '<script defer src="./assets/app.js">'),
        e('assets/app.js', 'onPluginEnter'), e('assets/app.js', 'typeof m=="string"&&m.trim()&&(s.value=m)')] },
    preloadDependencies: { directLiteralRequires: literalRequires, relativeLiteralRequires: literalRequires.filter((name) => name.startsWith('.')),
      thirdPartyLiteralRequires: literalRequires.filter((name) => !name.startsWith('.') && !name.startsWith('node:')),
      dynamicRequireObservedInReadablePreload: /require\s*\(\s*[^'"\s]/.test(preload),
      evidence: [e('preload/services.js', "require('node:fs')"), e('preload/services.js', "require('node:path')"), e('preload/package.json', '"type": "commonjs"')] },
    startup: { readablePreload: 'Top level imports two Node builtins and assigns window.services. Its fs.readFileSync/writeFileSync calls are inside service methods; no explicit top-level filesystem operation, directory creation, network listener/request, process launch or native addon load is present in this readable preload.',
      frontend: 'Mounts Vue, registers error/unhandledrejection listeners and onPluginEnter. On mount it attempts ztools.allAiModels. If models become available and pattern is non-empty, a watcher schedules AI explanation after 900ms; loading an example can trigger this too.',
      evidence: [e('preload/services.js', 'window.services = {'), e('assets/app.js', 'if(o!=null&&o.allAiModels)'),
        e('assets/app.js', 'f=setTimeout(()=>a(!1),900)'), e('assets/app.js', 'P&&String(b).trim()?p()'), e('assets/app.js', 'tc(ya).mount("#app")')] },
    hostAndSystemEffects: [
      { capability: 'readFile(file)', trigger: 'Explicit preload service invocation; frontend bundle has no literal services/readFile reference, which does not prove it is unreachable.', effect: 'Synchronous arbitrary caller-supplied path read with UTF-8 encoding; the preload method has no internal path allowlist.', evidence: e('preload/services.js', "fs.readFileSync(file, { encoding: 'utf-8' })") },
      { capability: 'writeTextFile(text)', trigger: 'Explicit preload service invocation', effect: 'Obtains host downloads directory and writes <timestamp>.txt there. Errors are caught and return undefined.', evidence: [e('preload/services.js', "window.ztools.getPath('downloads')"), e('preload/services.js', "fs.writeFileSync(filePath, text, { encoding: 'utf-8' })")] },
      { capability: 'writeImageFile(base64Url)', trigger: 'Explicit preload service invocation', effect: 'For matching data:image/<letters>;base64 prefix, writes timestamp.<extension> to host downloads directory. No try/catch around this method; invalid input returns without writing.', evidence: e('preload/services.js', "fs.writeFileSync(filePath, base64Url.substring(matchs[0].length), { encoding: 'base64' })") },
      { capability: 'clipboard', trigger: 'Copy button', effect: 'Writes /pattern/flags using navigator.clipboard.writeText or document.execCommand copy fallback, then asks host showNotification.', evidence: [e('assets/app.js', 'yield navigator.clipboard.writeText(v)'), e('assets/app.js', 'document.execCommand("copy")')] },
      { capability: 'host AI', trigger: 'Model enumeration at mount; explanation can auto-run after non-empty pattern changes when models are available; generation runs from entered requirement.', effect: 'Calls ztools.ai through the host, potentially causing external requests. Explanation sends pattern/flags; generation sends requirement. The package does not establish what provider/account/network boundary the host uses.', evidence: [e('assets/app.js', 'const v=`正则：/${P}/${t()}`'), e('assets/app.js', 'const O=I.ai({model:'), e('assets/app.js', 'yield i.chat([{role:"system",content:_c},{role:"user",content:b}])')] },
      { capability: 'AI settings/notifications', trigger: 'Configuration/copy/generation UI actions', effect: 'Invokes redirectAiModelsSetting/showNotification via host APIs.', evidence: [e('assets/app.js', 'redirectAiModelsSetting'), e('assets/app.js', 'showNotification')] } ],
    networkAndNativeBoundary: { nativeFiles: fixture.zip.nativeFiles, symlinkCount: fixture.zip.symlinkCount,
      readablePreloadNetworkListenerOrRequest: 'No such operation appears in the fully readable 34-line preload; only node:fs and node:path are imported.',
      childProcessAndElectron: 'No direct require of child_process/electron or relative dependency appears in preload. Browser bundle contains internal CommonJS-style module wrappers for bundled visualRegex; these are not evidence of a Node/electron dependency.',
      literalSignalObservations, externalUrlInterpretation: 'Observed bundle URLs include Vue/SVG namespace/documentation and example strings; those strings alone do not establish network requests. Host AI calls are a separate possible network path.' },
    businessAssertionCandidates: [
      { id: 'entry-payload', action: 'Enter editor with a short selected-text payload.', expected: 'Test-text textarea receives payload; editor feature is loaded.', status: 'not_executed', evidence: e('assets/app.js', 'typeof m=="string"&&m.trim()&&(s.value=m)') },
      { id: 'two-matches-and-capture', action: 'Set pattern (\\d+), flags g, test text abc123def456 with AI models unavailable.', expected: 'Two matches are highlighted, count is 2, first capture group is 123.', status: 'not_executed', evidence: [e('assets/app.js', 'O.push({index:E.index,length:E[0].length,groups:E.slice(1)})'), e('assets/app.js', 'c.value[0].groups.map')] },
      { id: 'invalid-pattern-recovery', action: 'Enter [ and then restore (\\d+).', expected: 'Invalid-regex error is shown; valid input restores matching and visual rendering.', status: 'not_executed', evidence: [e('assets/app.js', 'new RegExp(e.value,t.value)'), e('assets/app.js', 'i.value=v instanceof Error?v.message')] },
      { id: 'offline-explanation-and-visual', action: 'With AI unavailable, enter a short simple regex and text.', expected: 'Local Chinese explanation remains available and visualCanvas appends a canvas; no AI request is required.', status: 'not_executed', evidence: [e('assets/app.js', 'explanation:o'), e('assets/app.js', 'const o=new RegExp(t.pattern,t.flags),c=Ec(o).visualCanvas()'), e('assets/app.js', '未配置 AI 时使用本地规则解释')] },
      { id: 'example-load', action: 'Choose 中文字符 example with AI unavailable.', expected: 'Pattern [\\u4e00-\\u9fff]+, g flag and provided test text populate together; expected two Chinese segments.', status: 'not_executed', evidence: [e('assets/app.js', 'name:"中文字符"'), e('assets/app.js', 'e.value=v.pattern,t.value=v.flags||"g",n.value=v.testText')] } ],
    decisionBoundary: { status: 'prepared_for_parent_native_fixture_decision', pluginExecuted: false, businessAccepted: false,
      preloadServicesInvoked: false, browserOpened: false, aiNetworkInvoked: false,
      requiredParentControls: ['Keep the real production AI configuration unavailable/disabled and observe the original guarded offline branch; do not add a fake allAiModels API. Block renderer outbound connections and exclude AI actions: if real models are available, a non-empty regex or example can trigger AI automatically.',
        'Filesystem bridge services can access caller-supplied paths or real Downloads unless a real host capability boundary intercepts them. Do not infer OS confinement from private HOME.',
        'Use short bounded regex/text cases; synchronous JavaScript RegExp can stall on pathological inputs. No catastrophic-backtracking or unbounded stress input was executed.',
        'Keep clipboard/writeTextFile/writeImageFile/AI actions outside initial read/match/visual assertions unless separately scoped and observed.'],
      evidenceLimits: ['This is a pinned byte-level source review and assertion plan, not runtime/business acceptance or a blanket safety claim.',
        'assets/app.js is minified and has no source map in the seven-file package. Selected control-flow regions and literal surfaces were read; this is not a full deobfuscation, complete AST/data-flow audit or proof of absence of indirect behavior.',
        'No local development source was substituted for packaged source. All evidence anchors refer to the seven retained original package files.',
        'Private fixture/HOME ownership is not OS sandboxing. No npm, preload, browser, Node plugin code or native integration was executed.'] } };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== '--reuse-prepared')) throw new Error('Usage: node scripts/review-ztools-published-plugin.mjs [--reuse-prepared]');
  let fixture = null, newlyCreated = false;
  try {
    if (argv.includes('--reuse-prepared')) fixture = JSON.parse(await readFile(OUTPUT, 'utf8')).fixture;
    else {
      const audit = JSON.parse(await readFile(AUDIT, 'utf8'));
      const candidate = audit.candidates.find((row) => row.id === 'regex-editor');
      if (candidate?.archive?.locallyComputedSha256 !== PIN) throw new Error('Source audit no longer has the selected pinned regex-editor bytes');
      fixture = await preparePublishedPluginFixture(candidate); newlyCreated = true;
    }
    const review = await reviewRegexEditorFixture(fixture);
    const sources = ['scripts/review-ztools-published-plugin.mjs', 'scripts/lib/published-plugin-fixture.mjs',
      'scripts/audit-ztools-published-artifacts.mjs', 'scripts/lib/published-artifact-zip.mjs', 'scripts/lib/published-artifact-package.mjs'];
    const implementationSnapshot = await Promise.all(sources.map(async (file) => ({ file, sha256: sha256(await readFile(path.join(REPO, file))) })));
    const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), status: review.decisionBoundary.status,
      sourceAudit: path.relative(REPO, AUDIT), fixture, review, implementationSnapshot,
      retention: { retainedForParent: true, ownedRoot: fixture.ownedRoot, pluginRoot: fixture.pluginRoot,
        archivePath: fixture.archivePath, cleanupOwner: 'parent native-fixture workflow', cleanupOnPreparationFailure: true,
        boundary: 'Successful fixture intentionally retained; no business installation path or original source tree is changed.' } };
    await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report: path.relative(REPO, OUTPUT), status: report.status, pluginRoot: fixture.pluginRoot,
      archiveSha256: fixture.archiveSha256, originalFileCount: fixture.files.length, pluginExecuted: false, retainedForParent: true }));
  } catch (error) {
    if (newlyCreated && fixture) await rm(fixture.ownedRoot, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
