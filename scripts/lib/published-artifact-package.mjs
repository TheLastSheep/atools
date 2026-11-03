//! Static plugin entry/reference inspection over already preflighted in-memory ZIP files; never executes code.
import path from 'node:path';

export const STATIC_LIMITS = Object.freeze({ sourceFileBytes: 8 * 1024 * 1024,
  totalSourceBytes: 16 * 1024 * 1024, javascriptTokensPerFile: 1000000, javascriptTokensPerPackage: 1000000,
  referenceEdgesPerPackage: 16384, uniqueMissingPaths: 1024, diagnosticSamples: 64, diagnosticStringCharacters: 240 });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = (message) => { throw new Error(message); };
function boundedDiagnostic(value) {
  if (typeof value === 'string') return value.slice(0, STATIC_LIMITS.diagnosticStringCharacters);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, boundedDiagnostic(child)]));
  return value;
}
function collector(limit = STATIC_LIMITS.diagnosticSamples) {
  const values = []; let total = 0;
  return { values, push(...items) { for (const item of items) { total++; if (values.length < limit) values.push(boundedDiagnostic(item)); } },
    skip(count) { total += count; }, map(fn) { return values.map(fn); },
    get length() { return total; }, get omitted() { return total - values.length; },
    counts() { return { observed: total, samples: values.length, omitted: total - values.length }; } };
}

function resolveReference(root, from, value) {
  if (!value || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) return { external: value };
  const clean = decodeURIComponent(value.split(/[?#]/)[0]);
  if (!clean) return null;
  if (/[\\\u0000]/.test(clean)) fail(`Unsafe package reference: ${value}`);
  const resolved = path.posix.normalize(clean.startsWith('/') ? path.posix.join(root, clean.slice(1)) : path.posix.join(path.posix.dirname(from), clean));
  if (resolved === '..' || resolved.startsWith('../') || (root && resolved !== root && !resolved.startsWith(`${root}/`))) fail(`Reference leaves package root: ${value}`);
  return { name: resolved };
}
function javascriptReferences(text, budget) {
  const ignored = collector(8), uncertain = collector();
  let tokenCount = 0, scannedCharacters = 0;
  const examples = (raw, start, kind) => {
    for (const match of raw.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
      if (ignored.length < 8) ignored.push({ kind, reference: match[1], offset: start + match.index,
        excerpt: raw.slice(Math.max(0, match.index - 24), match.index + Math.min(match[0].length + 48, 160)) });
    }
  };
  function* tokenize() {
   let previous = null;
   for (let i = 0; i < text.length;) {
    scannedCharacters = i;
    if (tokenCount >= STATIC_LIMITS.javascriptTokensPerFile || budget.tokensRemaining <= 0) {
      uncertain.push({ kind: 'javascript_token_budget_exceeded', offset: i }); return;
    }
    const character = text[i], start = i;
    if (/\s/.test(character)) { i++; continue; }
    if (text.startsWith('//', i) || text.startsWith('/*', i)) {
      const line = text.startsWith('//', i), stop = line ? text.indexOf('\n', i + 2) : text.indexOf('*/', i + 2);
      i = stop < 0 ? text.length : stop + (line ? 1 : 2);
      examples(text.slice(start, i), start, 'comment'); continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      i++; let value = '', terminated = false;
      while (i < text.length) {
        const next = text[i++];
        if (next === character) { terminated = true; break; }
        if (next !== '\\') { value += next; continue; }
        if (i >= text.length) break;
        const escaped = text[i++];
        if (escaped === '\n') continue;
        if (escaped === '\r') { if (text[i] === '\n') i++; continue; }
        if (escaped === 'u' && text[i] === '{') {
          const stop = text.indexOf('}', i + 1), code = text.slice(i + 1, stop);
          if (stop >= 0 && /^[0-9a-f]{1,6}$/i.test(code) && parseInt(code, 16) <= 0x10ffff) {
            value += String.fromCodePoint(parseInt(code, 16)); i = stop + 1; continue;
          }
          uncertain.push({ kind: 'unsupported_unicode_string_escape', offset: i });
        }
        const hex = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 0;
        if (hex && new RegExp(`^[0-9a-f]{${hex}}$`, 'i').test(text.slice(i, i + hex))) {
          value += String.fromCharCode(parseInt(text.slice(i, i + hex), 16)); i += hex;
        } else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[escaped] ?? escaped;
      }
      if (!terminated) uncertain.push({ kind: 'unterminated_string_or_template', offset: start });
      if (character === '`' && /\$\{[\s\S]*\bimport\s*[({]/.test(value)) uncertain.push({ kind: 'import_inside_template_expression', offset: start });
      examples(value, start, character === '`' ? 'template_text' : 'string_text');
      tokenCount++; budget.tokensRemaining--;
      previous = { kind: character === '`' ? 'template' : 'string', value, offset: start }; yield previous; continue;
    }
    const regexPosition = !previous || (previous.kind === 'punct' && /^[=({\[,!:;?~%^&|*<>+\-]$/.test(previous.value))
      || (previous.kind === 'identifier' && /^(?:return|throw|case|yield|typeof|void|delete|in|of)$/.test(previous.value));
    if (character === '/' && regexPosition) {
      i++; let inClass = false;
      while (i < text.length) {
        const next = text[i++];
        if (next === '\\') { i++; continue; }
        if (next === '[') inClass = true;
        if (next === ']') inClass = false;
        if (next === '/' && !inClass) break;
      }
      while (/[a-z]/i.test(text[i] || '') && i < text.length) i++;
      tokenCount++; budget.tokensRemaining--;
      previous = { kind: 'regex', value: '', offset: start }; yield previous; continue;
    }
    const identifier = text.slice(i).match(/^[a-z_$][\w$]*/i)?.[0];
    if (identifier) { previous = { kind: 'identifier', value: identifier, offset: i }; i += identifier.length; }
    else { previous = { kind: 'punct', value: character, offset: i }; i++; }
    tokenCount++; budget.tokensRemaining--; yield previous;
   }
   scannedCharacters = text.length;
  }
  // A bounded lookahead replaces retention of the entire source token stream.
  const iterator = tokenize(), lookahead = [];
  let previousConsumed = null;
  const peek = (index = 0) => {
    while (lookahead.length <= index) { const next = iterator.next(); if (next.done) return undefined; lookahead.push(next.value); }
    return lookahead[index];
  };
  const take = () => { const token = peek(); if (token) { lookahead.shift(); previousConsumed = token; } return token; };
  const references = [];
  let referenceLimitReached = false;
  const add = (token, kind) => {
    if (token?.kind !== 'string' || !/^[./]/.test(token.value)) return;
    if (references.length >= STATIC_LIMITS.referenceEdgesPerPackage) {
      if (!referenceLimitReached) uncertain.push({ kind: 'javascript_reference_edge_budget_exceeded', offset: token.offset });
      referenceLimitReached = true; return;
    }
    references.push({ value: token.value, kind, offset: token.offset });
  };
  while (peek()) {
    const preceding = previousConsumed, token = take(), next = peek();
    if (token.kind !== 'identifier' || preceding?.value === '.') continue;
    if (token.value === 'new' && next?.value === 'URL' && peek(1)?.value === '(' && peek(3)?.value === ','
      && Array.from({ length: 5 }, (_, i) => peek(i + 4)?.value || '').join('') === 'import.meta.url') add(peek(2), 'js_new_url');
    if (token.value !== 'import' && token.value !== 'export') continue;
    if (next?.value === '.' || (token.value === 'export' && !['*', '{'].includes(next?.value))) continue;
    if (next?.kind === 'string') { add(take(), 'js_static_import'); continue; }
    if (next?.value === '(') {
      if (peek(1)?.kind === 'string' && peek(2)?.value === ')') add(peek(1), 'js_literal_dynamic_import');
      else uncertain.push({ kind: 'computed_dynamic_import', offset: token.offset });
      continue;
    }
    let depth = 0, found = false;
    while (peek()) {
      const current = take();
      if (current.value === '{') depth++;
      if (current.value === '}') { depth--; if (depth === 0 && token.value === 'export' && peek()?.value !== 'from') { found = true; break; } }
      if (!depth && current.value === 'from' && peek()?.kind === 'string') { add(take(), 'js_static_import'); found = true; break; }
      if (!depth && (current.value === ';' || ['import', 'export', 'const', 'function', 'class', 'return'].includes(current.value))) break;
    }
    if (!found) uncertain.push({ kind: 'unparsed_static_import_export', offset: token.offset });
  }
  return { references, ignored, uncertain, tokenCount, scannedCharacters };
}
function* assetReferences(name, text) {
  const css = /\.css$/i.test(name);
  const pattern = css ? /url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s*["']([^"']+)["']/gi : /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(pattern)) yield { value: match[1] || match[2], kind: css ? 'css_literal' : 'html_attribute', offset: match.index };
}

export function inspectPackage(files, expectedId) {
  const inspectionStart = performance.now();
  const manifests = [...files.keys()].filter((name) => /(?:^|\/)plugin\.json$/.test(name) && !name.startsWith('__MACOSX/'));
  const matches = [];
  for (const name of manifests) {
    if (files.get(name).length > 1024 * 1024) fail('plugin.json exceeds read quota');
    const manifest = JSON.parse(utf8.decode(files.get(name)));
    if (manifest.name === expectedId) matches.push({ name, manifest });
  }
  if (matches.length !== 1) fail(`Expected one ${expectedId} plugin.json; found ${matches.length}`);
  const { name, manifest } = matches[0], root = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
  const missing = new Set(), sourceEntries = new Set(), checked = new Set();
  const missingReferences = collector(), external = collector(), ignoredNonCodeDependencyExamples = collector();
  const uncertainReferences = collector(), legacyRegexOnlyMissingClues = collector(8);
  const scanBudget = { tokensRemaining: STATIC_LIMITS.javascriptTokensPerPackage };
  let scannedSourceBytes = 0, javascriptTokensScanned = 0, referenceEdgesObserved = 0;
  let inlineDataReferenceCount = 0;
  const queue = [];
  const declaration = (value, field) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') fail(`Invalid manifest ${field}`);
    const reference = resolveReference(root, name, value);
    if (!reference?.name) fail(`Manifest ${field} must be a local file`);
    if (!files.has(reference.name)) missing.add(reference.name);
    else queue.push(reference.name);
    return reference.name;
  };
  const main = declaration(manifest.main, 'main'), preload = declaration(manifest.preload, 'preload');
  if (!main && !preload) fail('Manifest has no main or preload');
  inspectEntries: while (queue.length) {
    const current = queue.shift();
    if (checked.has(current)) continue;
    checked.add(current);
    if (!/\.(?:html?|css|[cm]?js)$/i.test(current)) continue;
    const bytes = files.get(current);
    if (bytes.length > STATIC_LIMITS.sourceFileBytes || scannedSourceBytes + bytes.length > STATIC_LIMITS.totalSourceBytes) {
      uncertainReferences.push({ from: current, kind: 'static_source_byte_budget_exceeded' }); continue;
    }
    scannedSourceBytes += bytes.length;
    const text = bytes.toString('utf8'), javascript = /\.[cm]?js$/i.test(current) ? javascriptReferences(text, scanBudget) : null;
    if (javascript) {
      javascriptTokensScanned += javascript.tokenCount;
      ignoredNonCodeDependencyExamples.push(...javascript.ignored.map((item) => ({ from: current, ...item })));
      ignoredNonCodeDependencyExamples.skip(javascript.ignored.omitted);
      uncertainReferences.push(...javascript.uncertain.map((item) => ({ from: current, ...item })));
      uncertainReferences.skip(javascript.uncertain.omitted);
      // Diagnostics only: expose bounded context for the original regex's possible false positives.
      for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^;\n]{0,300}?\s+from\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
        if (legacyRegexOnlyMissingClues.length >= 8) break;
        const value = match[1] || match[2] || match[3];
        if (!/^[./]/.test(value)) continue;
        let reference;
        try { reference = resolveReference(root, current, value); } catch { continue; }
        if (reference?.name && !files.has(reference.name) && !javascript.references.some((item) => item.value === value)) {
          legacyRegexOnlyMissingClues.push({ from: current, reference: value, offset: match.index,
            excerpt: text.slice(Math.max(0, match.index - 96), match.index + Math.min(match[0].length + 96, 240)),
            boundary: 'Regex clue only; may be comment/string/example or outside lexical scan budget, never counted as a missing dependency.' });
        }
      }
    }
    const references = javascript?.references ?? assetReferences(current, text);
    for (const { value, kind, offset } of references) {
      if (referenceEdgesObserved >= STATIC_LIMITS.referenceEdgesPerPackage) {
        uncertainReferences.push({ from: current, kind: 'package_reference_edge_budget_exceeded', offset }); break inspectEntries;
      }
      referenceEdgesObserved++;
      if (value.startsWith('data:')) { inlineDataReferenceCount++; continue; }
      const reference = resolveReference(root, current, value);
      if (reference?.external) { external.push(value); continue; }
      if (!reference?.name) continue;
      if (/\.[jt]sx?$/.test(reference.name) && /\/(?:src|source)\//.test(`/${reference.name}`)) sourceEntries.add(reference.name);
      if (!files.has(reference.name)) {
        if (!missing.has(reference.name) && missing.size >= STATIC_LIMITS.uniqueMissingPaths) {
          uncertainReferences.push({ from: current, kind: 'unique_missing_path_budget_exceeded', offset }); break inspectEntries;
        }
        missing.add(reference.name); missingReferences.push({ from: current, reference: value, resolved: reference.name, kind,
          excerpt: offset == null ? null : text.slice(Math.max(0, offset - 40), offset + Math.min(value.length + 80, 180)) });
      }
      else queue.push(reference.name);
    }
  }
  return { manifestPath: name, name: manifest.name, version: String(manifest.version || ''), main, preload,
    platform: manifest.platform ?? null, checkedStaticFiles: checked.size, missingStaticFiles: [...missing],
    missingReferences: missingReferences.values, externalReferences: external.values, inlineDataReferenceCount,
    sourceBuildEntries: [...sourceEntries], uncertainReferences: uncertainReferences.values,
    ignoredNonCodeDependencyExamples: ignoredNonCodeDependencyExamples.values,
    legacyRegexOnlyMissingClues: legacyRegexOnlyMissingClues.values, diagnosticCounts: {
      missingReferences: missingReferences.counts(), externalReferences: external.counts(),
      uncertainReferences: uncertainReferences.counts(), ignoredNonCodeDependencyExamples: ignoredNonCodeDependencyExamples.counts(),
      legacyRegexOnlyMissingClues: legacyRegexOnlyMissingClues.counts() },
    scanning: { limits: STATIC_LIMITS, scannedSourceBytes, referenceEdgesObserved, unvisitedQueuedFiles: queue.length,
      javascriptTokensScanned, retainedTokenLookaheadMaximum: 10, inspectionDurationMs: Math.round((performance.now() - inspectionStart) * 100) / 100 },
    staticEntryComplete: missing.size === 0 && sourceEntries.size === 0 && uncertainReferences.length === 0,
    limits: 'Literal HTML src/href, CSS url/import and lexically identified JS import/new URL references only. Unparsed/computed imports conservatively prevent staticEntryComplete. No JS/preload execution, full JS parser, runtime fetch analysis, dependency resolution or runtime acceptance.' };
}
