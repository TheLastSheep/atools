#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.join(REPO, 'output/legacy-node-2026-10-15/original-entry-inventory.json');
const DEFAULT_OUTPUT = path.join(REPO, 'output/legacy-node-2026-10-15/source-build-readiness.json');
const LOCK_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const OUTPUT_DIRS = ['dist', 'release', 'build', 'out', 'output', '.output'];
const CONFIG_RE = /^(?:vite|webpack)\.config(?:\.[cm]?[jt]s)?$/;
const URL_RE = /https?:\/\/[^\s"'<>\])}]+/g;

function confinedFile(root, file) {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    return realFile.startsWith(realRoot + path.sep) ? realFile : null;
  } catch { return null; }
}
function readBounded(root, file, maxBytes) {
  const real = confinedFile(root, file);
  if (!real) return null;
  let fd;
  try {
    fd = fs.openSync(real, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return { text: buffer.subarray(0, bytes).toString('utf8'), truncated: bytes === maxBytes, realPath: real };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readJson(root, file) {
  const read = readBounded(root, file, 1024 * 1024);
  if (!read) return null;
  try { return JSON.parse(read.text); } catch { return null; }
}
function exists(file) { try { fs.lstatSync(file); return true; } catch { return false; } }
function safeRelative(root, value) {
  if (!value || typeof value !== 'string') return null;
  const resolved = path.resolve(root, value);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}
function canonicalOutputPath(file) {
  let cursor = path.resolve(file);
  const tail = [];
  while (!exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(file);
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  try { return path.join(fs.realpathSync(cursor), ...tail); } catch { return path.resolve(file); }
}
function fileDigest(root, file) {
  const real = confinedFile(root, file);
  if (!real) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'); } catch { return null; }
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function collectUrls(text) { return unique((text.match(URL_RE) || []).map((u) => u.replace(/[.,;:]$/, ''))); }

function inspectRow(row) {
  const root = safeRelative(path.join(REPO, 'ZTools-plugins/plugins'), path.basename(row.sourceRoot || row.id));
  if (!root || !exists(root)) return { id: row.id, inventoryStatus: row.status, classification: 'source_path_unavailable', sourceRoot: row.sourceRoot || null };
  const manifestPath = safeRelative(root, row.manifest || 'plugin.json');
  const packagePath = path.join(root, 'package.json');
  const manifest = manifestPath ? readJson(root, manifestPath) : null;
  const pkg = readJson(root, packagePath);
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const buildScript = typeof scripts.build === 'string' ? scripts.build : null;
  const lockfiles = LOCK_NAMES.filter((name) => exists(path.join(root, name)) && confinedFile(root, path.join(root, name))).map((name) => ({ name, sha256: fileDigest(root, path.join(root, name)) }));
  const packageManager = pkg?.packageManager || null;
  const pmVersion = packageManager && typeof packageManager === 'string' && packageManager.includes('@') ? packageManager.slice(packageManager.lastIndexOf('@') + 1).split('+')[0] : null;
  const inferredManagers = packageManager ? [] : unique(lockfiles.map(({ name }) => ({
    'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'yarn.lock': 'yarn', 'pnpm-lock.yaml': 'pnpm', 'bun.lock': 'bun', 'bun.lockb': 'bun',
  })[name]));
  const declaredMain = manifest && (manifest.main || manifest.plugin?.main || manifest.entry) || null;
  const manifestDir = manifestPath ? path.dirname(manifestPath) : '.';
  const manifestDirRelative = manifestDir === '.' ? '.' : path.relative(root, manifestDir);
  const mainFile = declaredMain ? safeRelative(root, path.resolve(manifestDir === '.' ? root : manifestDir, declaredMain.replace(/^[/\\]+/, ''))) : null;
  const existingOutputDirs = OUTPUT_DIRS.filter((name) => {
    try { return fs.lstatSync(path.join(root, name)).isDirectory(); } catch { return false; }
  });
  const buildText = buildScript || '';
  const configFiles = (() => { try { return fs.readdirSync(root).filter((name) => CONFIG_RE.test(name)); } catch { return []; } })();
  const buildConfigEvidence = [];
  for (const name of configFiles) {
    const file = path.join(root, name);
    const read = readBounded(root, file, 32 * 1024);
    if (!read) continue;
    const lines = read.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const viteMatch = name.startsWith('vite.config') ? line.match(/\boutDir\s*:\s*(['"])([^'"]+)\1/) : null;
      const webpackOutputContext = name.startsWith('webpack.config') && lines.slice(Math.max(0, index - 12), index + 1).some((candidate) => /\boutput\s*:\s*\{?/.test(candidate));
      const webpackMatch = webpackOutputContext ? line.match(/\bpath\s*:\s*(?:path\.(?:resolve|join)\([^,]+,\s*)?(['"])([^'"]+)\1/) : null;
      const match = viteMatch || webpackMatch;
      if (match) buildConfigEvidence.push({ file: name, line: index + 1, value: match[2], excerpt: line.trim().slice(0, 240), kind: viteMatch ? 'vite_outDir_literal' : 'webpack_output_path_literal' });
    }
  }
  const explicitOutputTargets = unique(buildConfigEvidence.map((item) => item.value.replace(/^\.\//, '').split('/')[0]));
  const inferredOutputTargets = unique([...explicitOutputTargets, ...existingOutputDirs]);
  const viteDefaultGuess = !explicitOutputTargets.length && /\bvite\s+build\b/.test(buildText) ? 'dist' : null;
  if (viteDefaultGuess && !inferredOutputTargets.includes(viteDefaultGuess)) inferredOutputTargets.push(viteDefaultGuess);
  const readmeCandidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
  const readmeName = readmeCandidates.find((name) => exists(path.join(root, name)) && confinedFile(root, path.join(root, name)));
  const readmeRead = readmeName ? readBounded(root, path.join(root, readmeName), 12 * 1024) : null;
  const readmeText = readmeRead?.text || '';
  const urlCandidates = [
    ...(manifest ? [manifest.repository?.url, typeof manifest.repository === 'string' ? manifest.repository : null, manifest.homepage].filter(Boolean).map((url) => ({ url, source: 'manifest' })) : []),
    ...(pkg ? [pkg.repository?.url, typeof pkg.repository === 'string' ? pkg.repository : null, pkg.homepage].filter(Boolean).map((url) => ({ url, source: 'package.json' })) : []),
    ...collectUrls(readmeText).map((url) => ({ url, source: readmeName })),
  ];
  const clueMap = new Map();
  for (const clue of urlCandidates) {
    if (!/github\.com|gitlab\.com|gitee\.com|ztool|utool|release|market|marketplace/i.test(clue.url)) continue;
    const prior = clueMap.get(clue.url) || { url: clue.url, sources: [] };
    if (!prior.sources.includes(clue.source)) prior.sources.push(clue.source);
    clueMap.set(clue.url, prior);
  }
  const selectedUrls = [...clueMap.values()].slice(0, 12);
  let nodeModules = { exists: false, symlink: false, directory: false };
  try { const stat = fs.lstatSync(path.join(root, 'node_modules')); nodeModules = { exists: true, symlink: stat.isSymbolicLink(), directory: stat.isDirectory() }; } catch { /* absent */ }
  const localNodeModules = nodeModules.directory;
  const preconditions = {
    packageJsonPresent: !!pkg,
    packageName: pkg?.name || null,
    packageVersion: pkg?.version || null,
    packageManager: packageManager ? { declaration: packageManager, version: pmVersion } : null,
    inferredManagers,
    lockfiles,
    rootNodeModules: nodeModules,
    buildScript,
    sourceEntries: row.scripts || [],
    manifestMain: declaredMain ? { declared: declaredMain, resolvedRelativeTo: manifestDirRelative, exists: !!mainFile && exists(mainFile), path: mainFile ? path.relative(root, mainFile) : null } : null,
    outputEvidence: { configLiterals: buildConfigEvidence, viteDefaultGuess, existingDirectories: existingOutputDirs },
    inferredOutputTargets: inferredOutputTargets.map((name) => ({
      path: name,
      exists: existingOutputDirs.includes(name),
      evidence: existingOutputDirs.includes(name) ? 'directory_present' : explicitOutputTargets.includes(name) ? 'build_config_literal' : 'vite_default_guess',
    })),
    upstreamArtifactClues: selectedUrls,
    readmeInspected: readmeName ? `${readmeName} (bounded to first 12288 bytes${readmeRead?.truncated ? ', truncated' : ''})` : null,
  };
  let classification;
  if (pkg && buildScript && localNodeModules) classification = explicitOutputTargets.length ? 'local_preconditions_reviewable' : 'ambiguous_build_output';
  else if (selectedUrls.length && (!pkg || !buildScript)) classification = 'upstream_artifacts_clue_only';
  else if (!localNodeModules && pkg && buildScript) classification = 'dependency_absent_or_unverified';
  else classification = 'ambiguous_build_output';
  return {
    id: row.id,
    inventoryStatus: row.status,
    sourceRoot: row.sourceRoot,
    manifest: row.manifest || null,
    classification,
    preconditions,
    evidenceLimits: ['Metadata and path-presence inventory only; no dependency resolution, build, plugin script, network fetch, or runtime validation was performed.', 'Classification does not claim that a build succeeds or that inferred outputs are correct.'],
  };
}

function main() {
  const outputFlag = process.argv.indexOf('--output');
  const outputArg = outputFlag >= 0 ? process.argv[outputFlag + 1] : null;
  const output = outputFlag >= 0 ? path.resolve(outputArg || '') : DEFAULT_OUTPUT;
  if (outputFlag >= 0 && !outputArg) throw new Error('--output requires a file path');
  const pluginTree = path.join(REPO, 'ZTools-plugins/plugins');
  const canonicalOutput = canonicalOutputPath(output);
  const realPluginTree = (() => { try { return fs.realpathSync(pluginTree); } catch { return pluginTree; } })();
  if (canonicalOutput === realPluginTree || canonicalOutput.startsWith(realPluginTree + path.sep)) throw new Error('--output cannot target ZTools-plugins/plugins');
  if (canonicalOutput === path.resolve(INVENTORY)) throw new Error('--output cannot overwrite the source inventory');
  const input = readJson(REPO, INVENTORY);
  if (!input || !Array.isArray(input.rows)) throw new Error(`Invalid inventory: ${INVENTORY}`);
  const selected = input.rows.filter((row) => row.status === 'source_entry_requires_build');
  const rows = selected.map(inspectRow);
  const counts = rows.reduce((acc, row) => { acc[row.classification] = (acc[row.classification] || 0) + 1; return acc; }, {});
  const buildScriptFamilies = rows.reduce((acc, row) => {
    const script = row.preconditions?.buildScript || '(none)';
    acc[script] = (acc[script] || 0) + 1;
    return acc;
  }, {});
  const lockfileCounts = rows.reduce((acc, row) => {
    for (const lock of row.preconditions?.lockfiles || []) acc[lock.name] = (acc[lock.name] || 0) + 1;
    return acc;
  }, {});
  const result = {
    schema_version: 1,
    generatedAt: new Date().toISOString(),
    source: path.relative(REPO, INVENTORY),
    scope: {
      includedInventoryStatus: 'source_entry_requires_build',
      includedRowCount: rows.length,
      inspectedRoot: 'ZTools-plugins/plugins/<plugin-id>',
      inspected: ['confined root package.json and scripts.build', 'confined known root lockfile names and SHA-256 only', 'root node_modules lstat metadata only', 'confined manifest main resolved against manifest directory', 'confined root Vite/webpack literal output config and bounded README URL clues', 'common output-directory metadata'],
      exclusions: ['No dependency installation, build, plugin/package script, preload, network request, binary execution, HOME/config scan, or lockfile content dump.', 'No claim of build success from metadata.'],
      classificationMeaning: {
        local_preconditions_reviewable: 'package metadata, build script, root node_modules directory, and a literal Vite/webpack output path are reviewable locally; build remains unverified.',
        dependency_absent_or_unverified: 'package metadata and build script exist, but root node_modules is absent.',
        ambiguous_build_output: 'Build target or local build preconditions are incomplete/unclear.',
        upstream_artifacts_clue_only: 'Repository/release/market URL clues exist, while package or build-script metadata is absent; this is not evidence that an upstream artifact exists.',
        source_path_unavailable: 'Inventory plugin source root is missing or outside the allowed plugin tree.',
      },
    },
    summary: {
      total: rows.length,
      classifications: counts,
      lockfileCounts,
      inferredManagers: rows.reduce((acc, row) => { for (const manager of row.preconditions?.inferredManagers || []) acc[manager] = (acc[manager] || 0) + 1; return acc; }, {}),
      buildScriptFamilies,
      rootNodeModulesPresent: rows.filter((row) => row.preconditions?.rootNodeModules?.directory).map((row) => row.id),
      upstreamArtifactClueRows: rows.filter((row) => row.preconditions?.upstreamArtifactClues?.length).length,
      upstreamOnlyRows: rows.filter((row) => row.classification === 'upstream_artifacts_clue_only').length,
    },
    rows,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, total: rows.length, classifications: counts }, null, 2));
}

main();
