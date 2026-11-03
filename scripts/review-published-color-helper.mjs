#!/usr/bin/env node
// Byte-pinned package review, without evaluating preload or page code.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVerifiedPublishedPluginFixture, sha256 } from './lib/published-plugin-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '6906b2b1fba4368ccf60f3f5ce7d67e308bd6a6b90629f31fb235fa80f303f19';
const COHORT = 'output/legacy-node-2026-10-15/published-review-cohort.json';
const OUTPUT = 'output/legacy-node-2026-10-15/published-color-helper-source-review.json';
const MAIN = 'assets/index-Bc94e4cn.js';

export async function reviewColorHelper(fixture) {
  if (fixture.id !== 'color-helper' || fixture.version !== '1.1.0' || fixture.archiveSha256 !== PIN)
    throw new Error('This review only covers color-helper@1.1.0 at the explicit ZIP pin');
  const { files, verification } = await readVerifiedPublishedPluginFixture(fixture, PIN);
  if (files.size !== 14) throw new Error('Pinned fourteen-file inventory mismatch');
  const text = name => { if (!files.has(name)) throw new Error(`Missing pinned file ${name}`); return files.get(name).toString('utf8'); };
  const anchor = (file, needle) => {
    const source = text(file), offset = source.indexOf(needle);
    if (offset < 0) throw new Error(`Pinned source anchor absent: ${file}: ${needle}`);
    return { file, characterOffset: offset, excerpt: source.slice(Math.max(0, offset - 40), offset + Math.min(needle.length + 150, 260)),
      boundary: 'Exact original ZIP text excerpt; minified offsets are not complete AST/data-flow proof' };
  };
  const manifest = JSON.parse(text('plugin.json')), preload = text('preload.cjs'), bundle = text(MAIN);
  if (manifest.name !== fixture.id || manifest.version !== fixture.version || manifest.preload !== 'preload.cjs'
    || !manifest.platform.includes('darwin')) throw new Error('Pinned package identity or platform changed');
  const lazyModules = ['GradientsPage-MDFpj4Fw.js', 'ImagePalettePage-BTOwXOBQ.js', 'AIPalettePage-BVC3MHC0.js'];
  const lazyEvidence = lazyModules.map(name => {
    if (!files.has(`assets/${name}`)) throw new Error(`Missing reviewed local lazy module ${name}`);
    return anchor(MAIN, 'import(`./' + name + '`)');
  });
  const uncertainty = fixture.package.uncertainReferences;
  if (uncertainty.length !== 3 || uncertainty.some(row => row.from !== MAIN || row.kind !== 'computed_dynamic_import'))
    throw new Error('Static uncertainty differs from the three reviewed template-literal imports');
  const roles = name => name === 'plugin.json' ? 'Manifest, exact feature identities and cross-platform declarations'
    : name === 'preload.cjs' ? 'Readable 32-line fs/promises, Buffer and path preload; exposes one saveColorCard method'
    : name === 'index.html' ? 'Root mount, module entry and stylesheet'
    : name === MAIN ? 'React/MUI/chroma bundles plus UI, color conversion, palette/collection and host adapters'
    : name.includes('AIPalettePage') ? 'Lazy AI palette UI; excluded from initial execution'
    : name.includes('ImagePalettePage') ? 'Lazy image upload/screen extraction and image-card UI; excluded'
    : name.includes('GradientsPage') ? 'Lazy local gradient collection and export UI; browsing only in scope'
    : name.includes('Stack-') ? 'MUI layout helper, imports symbols from original main module'
    : name.endsWith('.css') ? 'Original local stylesheet' : 'Original binary image; hashed without decoding in review';
  return {
    verification, evidenceSource: 'CRC-verified pinned ZIP buffer after exact retained-file verification',
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes), role: roles(name) })),
    entry: { id: manifest.name, title: manifest.title, version: manifest.version, featureCode: 'color', searchQuery: '颜色',
      runtime: 'node', main: manifest.main, preload: manifest.preload, platform: manifest.platform,
      featureCodes: manifest.features.map(feature => feature.code),
      evidence: [anchor('index.html', '<script type="module"'), anchor(MAIN, 'yf.createRoot(document.getElementById(`root`)).render'),
        anchor(MAIN, 'componentDidMount(){gg(({code:e,type:t,payload:n})=>')] },
    staticUncertaintyReview: { originalStaticEntryComplete: false, originalDiagnostics: uncertainty,
      resolution: 'Each reported computed import is a no-interpolation template-literal spelling of one exact local module. All three targets and their literal local imports are in the verified ZIP. The scanner budget/classification is retained unchanged.',
      evidence: lazyEvidence, sourceNotRewritten: true, runtimeModuleGraphNotYetVerified: true },
    preload: { literalRequires: [...preload.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]),
      startup: 'Only imports builtins, aliases window.ztools to window.platform, and defines saveColorCard. The fully readable function performs writes/dialogs only when explicitly called.',
      saveEffects: 'saveColorCard resolves Downloads, asks the host save dialog, writes the chosen path through fs/promises and requests shellShowItemInFolder. It has no path allowlist and is excluded.',
      evidence: [anchor('preload.cjs', "require('fs/promises')"), anchor('preload.cjs', 'window.platform = platform;'),
        anchor('preload.cjs', 'async saveColorCard(bf)'), anchor('preload.cjs', 'await writeFile(savePath, buffer);')] },
    frontend: { startup: 'Mounts React StrictMode/MUI, registers onPluginEnter/Out, reads plugin setting, and selects the requested navigation page. color creates a local random color without invoking picker/AI. React.lazy callbacks defer three optional pages.',
      storage: 'Uses real ztools.dbStorage and synchronous ztools.db when present, with localStorage fallbacks only for browser use. Collection dialogs call db.get/put; collection sort uses dbStorage.',
      activeEffects: 'MUI focus trap installs a 50ms interval while dialogs are open and removes it with the effect cleanup; closing the plugin must reclaim the entire iframe and Node session.',
      evidence: [anchor(MAIN, 'ag=window.platform'), anchor(MAIN, 'if(ag?.dbStorage)return ag.dbStorage.getItem(e)'),
        anchor(MAIN, 'let t=ag.db.put(e);return{ok:'), anchor(MAIN, 'handleValueChange=e=>t=>'),
        anchor(MAIN, 'this.setState({error:`错误的色值`})'), anchor(MAIN, 'clearInterval(i),e.removeEventListener(`focusin`')] },
    excludedEffects: [
      { action: 'Color/card copy', effect: 'Calls host copyText/copyImage or browser clipboard/download fallback; not clicked', evidence: anchor(MAIN, 'if(ag?.copyText){ag.copyText(e);return}') },
      { action: 'Screen picker/capture', effect: 'Invokes host screenColorPick/screenCapture or EyeDropper; excluded', evidence: anchor(MAIN, 'if(ag?.screenColorPick){ag.screenColorPick(e);return}') },
      { action: 'AI palette', effect: 'Explicit AI navigation/model action can invoke real ztools.ai; excluded and production AI settings disabled', evidence: anchor(MAIN, 'return ag.ai({model:t,messages:e})') },
      { action: 'Save/export/image upload', effect: 'Can call saveColorCard, native dialog/file IO or download helpers; excluded' }
    ],
    assertionPlan: ['Set HEX ff0000 and assert original RGB=255,0,0 and background red',
      'Enter invalid HEX, observe retained raw input, then valid green and assert RGB/background recovery',
      'Open 收藏颜色, create a named color through real dialog, switch away/back and assert persisted row; no copy click',
      'Browse local 渐变色 lazy page to exercise original module graph, without export/AI/image actions',
      'Close to launcher, assert focus and zero owned runtime counts'],
    decisionBoundary: { status: 'prepared_for_parent_native_fixture_decision', pluginExecuted: false, runtimeAccepted: false,
      requiredControls: ['Only color/collection/local gradient navigation and bounded text inputs',
        'Real temporary plugin DB and disabled production AI; no fabricated clipboard, AI, filesystem or database API',
        'Renderer outbound origins blocked; Node permission is a real broad OS-capability grant, private HOME is not an OS sandbox',
        'Pin all fourteen original files before and after runtime; explicit case opt-in only'],
      limits: ['Minified frontend/vendor source is not fully deobfuscated or AST/data-flow audited.',
        'Literal substring and selected control-flow checks do not prove absence of indirect side effects.',
        'Current official version differs from local source 1.0.0; all evidence here is for actual published 1.1.0 bytes.',
        'Static local import inventory does not establish WebKit/CSP/native host module compatibility.'] }
  };
}

export async function main() {
  const cohort = JSON.parse(await readFile(path.join(ROOT, COHORT), 'utf8'));
  const fixture = cohort.candidates.find(row => row.id === 'color-helper')?.fixture;
  const review = await reviewColorHelper(fixture);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: review.decisionBoundary.status,
    sourceAudit: COHORT, fixture, review,
    implementationSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    retention: { retainedForParent: true, ownedRoot: fixture.ownedRoot, archivePath: fixture.archivePath,
      cleanupOwner: 'Parent native-fixture workflow; exact owned prepared directory only' } };
  await writeFile(path.join(ROOT, OUTPUT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: OUTPUT, status: report.status, sourceFileCount: review.files.length, pluginExecuted: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
