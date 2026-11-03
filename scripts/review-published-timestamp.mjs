#!/usr/bin/env node
//! Non-executing source review of one retained original timestamp release ZIP.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVerifiedPublishedPluginFixture, sha256 } from './lib/published-plugin-fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COHORT = 'output/legacy-node-2026-10-15/published-review-cohort.json';
const OUTPUT = 'output/legacy-node-2026-10-15/published-timestamp-source-review.json';
const PIN = '6257a356df9d1086dde5dea9587e304fd7dce0688e34842bd0acdc469330eaea';
const JS = 'assets/index-Cp7fjPHZ.js', CSS = 'assets/index-CbKtl592.css';
const EXPECTED_FILES = [CSS, JS, 'index.html', 'logo.png', 'plugin.json'].sort();

function anchor(text, file, needle) {
  const characterOffset = text.indexOf(needle);
  if (characterOffset < 0) throw Error(`Pinned source evidence missing: ${file}: ${needle}`);
  return { file, line: text.slice(0, characterOffset).split('\n').length, characterOffset,
    byteOffset: Buffer.byteLength(text.slice(0, characterOffset)), needle,
    excerpt: text.slice(Math.max(0, characterOffset - 35), characterOffset + needle.length + 105),
    boundary: 'Original UTF-8 text from the pinned ZIP Buffer. Bundle offsets are not readable source or full AST/data-flow proof.' };
}

export async function reviewTimestampFixture(fixture) {
  if (fixture.id !== 'com-ztools-timestamp' || fixture.version !== '1.0.0' || fixture.archiveSha256 !== PIN) {
    throw Error('Review restricted to pinned com-ztools-timestamp 1.0.0');
  }
  const { verification, files } = await readVerifiedPublishedPluginFixture(fixture, PIN);
  if ([...files.keys()].sort().join('\n') !== EXPECTED_FILES.join('\n')) throw Error('Pinned five-file inventory mismatch');
  const texts = Object.fromEntries([...files].filter(([name]) => name !== 'logo.png').map(([name, bytes]) => [name, bytes.toString('utf8')]));
  const manifest = JSON.parse(texts['plugin.json']), bundle = texts[JS], css = texts[CSS];
  const e = (file, needle) => anchor(texts[file], file, needle);
  if (manifest.preload || manifest.name !== fixture.id || manifest.version !== fixture.version
    || manifest.features.length !== 1 || !verification.package.staticEntryComplete || fixture.zip.nativeFiles.length) {
    throw Error('Pinned source no longer satisfies this Web-only review');
  }
  const roles = {
    'plugin.json': 'Metadata, one timestamp feature, main/icon and development-only localhost URL. No preload or platform restriction.',
    'index.html': 'Empty app mount, one module script and one local stylesheet; no inline plugin business code.',
    [JS]: 'Vue 3.5.32/runtime plus all timestamp/date/picker/theme UI business logic in one minified bundle; no source map in ZIP.',
    [CSS]: 'Local UI/theme/picker styles. Literal url(...) and @import scan has zero occurrences.',
    'logo.png': 'Manifest icon binary; bytes hashed and retained, not decoded or rendered by this source review.'
  };
  const signals = ['import(', 'require(', 'eval(', 'new Function', 'child_process', 'electron', '.node', 'fetch(',
    'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie',
    'dbStorage', '.db.', 'window.services', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'onPluginOut'];
  const literalSignalObservations = signals.map(signal => ({ signal, bundleOccurrences: bundle.split(signal).length - 1,
    boundary: 'Finite literal substring inventory only; absence cannot rule out computed or indirect behavior.' }));
  const epochLondon = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(0));
  return {
    verification, evidenceSource: 'One reverified SHA-pinned, CRC-checked original ZIP Buffer snapshot; no local development sources substituted.',
    files: [...files].map(([filename, bytes]) => ({ path: filename, bytes: bytes.length, sha256: sha256(bytes),
      verifiedUnchanged: true, role: roles[filename], evidenceSource: 'pinned_zip_buffer_snapshot' })),
    registry: { caseId: fixture.id, id: fixture.id, version: fixture.version, archiveSha256: PIN, fileCount: files.size,
      featureCode: manifest.features[0].code, searchQuery: '时间戳转换', title: manifest.title, runtime: 'web',
      sourceReview: OUTPUT, frameOperations: 'tests/components/nativePublishedTimestampFrameOperations.js' },
    entry: { main: manifest.main, preload: null, platform: null, triggerData: manifest.features[0].cmds,
      evidence: [e('plugin.json', '"code": "com-ztools-timestamp"'), e('index.html', '<script type="module" crossorigin src="./assets/index-Cp7fjPHZ.js">'),
        e(JS, 'Cc(Bu).mount("#app")'), e(JS, 'wn.onPluginEnter'), e(JS, 'window.dispatchEvent(new CustomEvent("ztools-enter",{detail:e.payload}))')] },
    startup: { behavior: 'Mounts Vue UI, derives local timezone from current offset, initializes theme via optional host isDarkColors/matchMedia, optionally calls setExpendHeight(600), registers ztools-enter and document-click handlers, and starts a 100ms current-clock interval. No preload or Node process is required.',
      evidence: [e(JS, 'const t=-new Date().getTimezoneOffset()/60'), e(JS, 'function c(){r=setInterval(()=>{i.value||(o.value=s())},100)}'),
        e(JS, 'return yt(c),Bt(d)'), e(JS, 'H.setExpendHeight'), e(JS, 'n.isDarkColors')] },
    dateAndUnitLogic: { behavior: 'Second/millisecond conversion is arithmetic around epoch milliseconds; nanoseconds use BigInt. Timestamp input accepts optional leading minus plus decimal digits; 10/13/18-20 digits automatically change unit. Rendering uses Intl with a named IANA zone. Picker reverse conversion subtracts the zone entry static offset from Date.UTC.',
      evidence: [e(JS, 'function ji(e,t)'), e(JS, 'case"second":return Math.floor(e/1e3).toString()'),
        e(JS, 'function Oc(e,t)'), e(JS, 'n===10?"second":n===13?"millisecond":n>=18&&n<=20?"nanosecond":null'),
        e(JS, 'function Le(e,t)'), e(JS, 'return Date.UTC(e,t-1,n,s,o,i)-r.offset*36e5'),
        e(JS, 'class:"tz-select"'), e(JS, 'placeholder:"请输入时间戳"'), e(JS, '"无效时间戳"')] },
    clockAndCleanup: { behavior: 'Current time reads performance.timeOrigin+performance.now, with Date.now fallback; no system-clock write. Pause only prevents updating the ref: the 100ms interval continues waking. A Vue unmount hook clears the interval. The date picker removes resize and keydown listeners on unmount; root removes click and ztools-enter listeners. Short copy/detection/toast setTimeout handles clear a prior timer when repeated, but these business timers have no explicit component-unmount cleanup in the reviewed sections. Destroying the iframe is still the host lifecycle boundary to verify.',
      evidence: [e(JS, 'performance.timeOrigin+performance.now():Date.now()'), e(JS, 'function d(){r&&(clearInterval(r),r=null)}'),
        e(JS, 'function a(){i.value=!i.value}'), e(JS, 'window.removeEventListener("resize",b)'),
        e(JS, 'document.removeEventListener("keydown",vn)'), e(JS, 'document.removeEventListener("click",J),window.removeEventListener("ztools-enter",Z)'),
        e(JS, 'h=setTimeout(()=>{a.value=!1},2e3)'), e(JS, 'D=setTimeout(()=>{b.value=!1},1800)')] },
    networkStorageAndClipboard: { preload: 'Absent. No Node dependency/package file/native addon in the exact five-file inventory.',
      network: 'One literal fetch is Vite modulepreload fallback for observed link[rel=modulepreload] nodes, including a MutationObserver. The static HTML has no such links and all current entry references are local. No explicit business HTTP/WebSocket/XHR call appears in the read timestamp control-flow region. URL literals elsewhere are SVG/MathML/XLink namespaces and Vue error documentation. This is a bounded source observation, not an enforced network sandbox.',
      storage: 'No literal localStorage/sessionStorage/indexedDB/document.cookie/dbStorage/.db. usage found in the original JS. Theme and entered values are in Vue refs. No persistent-storage capability is exercised by planned operations.',
      clipboard: 'Current timestamp and result rows/buttons call optional ztools.copyText, falling back to navigator.clipboard.writeText. The scenario must never click current timestamp, multi-result rows or copy buttons; it reads result text only.',
      evidence: [e(JS, 'document.querySelectorAll(\'link[rel="modulepreload"]\')'), e(JS, 'fetch(o.href,i)'),
        e(JS, 'window.ztools.copyText(b):navigator.clipboard.writeText(b)'), e(JS, 'title:"点击复制: "+P'),
        e(JS, 'class:"current-ts-value",title:s.value?"已复制":"点击复制"')],
      cssReferences: { literalUrlOccurrences: css.split('url(').length - 1, literalImportOccurrences: css.split('@import').length - 1 },
      literalSignalObservations },
    knownSourceDefects: [{ id: 'london-label-is-not-fixed-utc', severity: 'business_correctness',
      behavior: 'The UTC+00 London option uses Europe/London, which had UTC+1 at Unix epoch. Timestamp 0 therefore renders 1970-01-01 01:00:00, while reverse picker conversion for the same option uses fixed offset 0. DST/historical dates can fail round-trip; the label is not a fixed-UTC selector.',
      independentHostIntlObservation: { pluginCodeExecuted: false, epochLondon, epochUtcIso: new Date(0).toISOString(),
        boundary: 'This calls host Node Intl only to demonstrate the source-selected timezone distinction. Native WebView behavior is still unexecuted.' },
      evidence: [e(JS, '{label:"UTC+00:00 | 伦敦",offset:0,iana:"Europe/London"}'),
        e(JS, 'timeZone:t.iana'), e(JS, 'return Date.UTC(e,t-1,n,s,o,i)-r.offset*36e5')] }],
    businessAssertionCandidates: [
      { id: 'epoch-observation', action: 'Select London by genuine select/change; choose seconds by unit button and input 0.', expected: 'Observe original historical London 01:00 display and explicitly record that strict Unix0->UTC00 acceptance remains failed, not silently normalize plugin output.', status: 'not_executed' },
      { id: 'modern-winter-conversion', action: 'Input 1704164645 seconds and 1704164645000 milliseconds with London selected.', expected: 'Both render 2024-01-02 03:04:05; unit auto-detection and hint reflect seconds/milliseconds.', status: 'not_executed' },
      { id: 'reverse-picker', action: 'Open readonly date field, use actual calendar/year/month/day and hour/minute/second buttons to select 2024-01-02 03:04:05, confirm; toggle unit.', expected: 'Original result is 1704164645 seconds and 1704164645000 milliseconds; no calls to plugin internal date functions or direct reactive state writes.', status: 'not_executed' },
      { id: 'invalid-and-recovery', action: 'Input invalid alphabetic text then valid fixed timestamp.', expected: 'Original 无效时间戳/error class suppress date results; restoring valid text restores results and clears error.', status: 'not_executed' },
      { id: 'pause-resume', action: 'Click pause, observe current timestamp stable, resume, observe advancing value.', expected: 'Pause/resume original UI behavior; no system clock change. Timer lifecycle/total-process CPU still requires host evidence.', status: 'not_executed' }
    ],
    decisionBoundary: { status: 'prepared_for_parent_native_fixture_decision_with_known_upstream_defect', pluginExecuted: false,
      businessAccepted: false, browserOpened: false, clipboardInvoked: false, systemClockModified: false,
      requiredParentControls: ['Preserve ZIP/hash and exact source bytes; do not patch upstream timezone logic to obtain a passing result.',
        'No renderer outbound connection, clipboard/copy action, system-clock mutation, dependency installation or Node plugin execution in this scenario.',
        'Record historical-London/fixed-UTC mismatch as an upstream business defect and exclude strict UTC correctness from accepted coverage.',
        'Only short finite inputs and bounded calendar navigation. Observe real iframe close and host runtime drain; private HOME/0700 fixture is not OS isolation.',
        'Measure plugin-visible 100ms clock work separately from launcher idle; pause does not stop this source interval.'],
      evidenceLimits: ['Only the five verified original published ZIP files were reviewed; no local source/build substitution.',
        'Selected business/control-flow regions and finite literal surfaces were read from a minified 95KB bundle; no complete deobfuscation, AST or absence proof.',
        'This artifact is a non-executing byte/source review and operation plan, never runtime acceptance, majority compatibility, signature verification or blanket safety proof.'] }
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw Error('Usage: node scripts/review-published-timestamp.mjs');
  const cohortBytes = await readFile(path.join(REPO, COHORT));
  const cohort = JSON.parse(cohortBytes), candidate = cohort.candidates.find(row => row.id === 'com-ztools-timestamp');
  if (candidate?.archive?.locallyComputedSha256 !== PIN) throw Error('Cohort lacks pinned timestamp ZIP');
  const review = await reviewTimestampFixture(candidate.fixture);
  const sourceFiles = ['scripts/review-published-timestamp.mjs', 'scripts/lib/published-plugin-fixture.mjs',
    'scripts/lib/published-artifact-zip.mjs', 'scripts/lib/published-artifact-package.mjs'];
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: review.decisionBoundary.status,
    sourceAudit: COHORT, sourceAuditSha256: sha256(cohortBytes), fixture: candidate.fixture,
    publisherSignatureVerified: false, upstreamChecksumVerified: false, review,
    implementationSnapshot: await Promise.all(sourceFiles.map(async file => ({ file, sha256: sha256(await readFile(path.join(REPO, file))) }))),
    retention: { retainedForParent: true, cleanupOwner: 'Parent source-review/native fixture workflow',
      boundary: 'Review never materializes, executes, builds, installs, downloads or removes plugin bytes.' } };
  await writeFile(path.join(REPO, OUTPUT), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: OUTPUT, status: report.status, files: review.files.length, pluginExecuted: false,
    archiveSha256: PIN, knownUpstreamDefects: review.knownSourceDefects.map(row => row.id) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
