import { analyzePluginSource, type PluginSourceToken } from "./pluginSourceAnalysis";

const MAX_SOURCE_UNITS = 128 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_TOKENS = 16_384;
const MAX_ALIASES = 64;
const PATH_REQUESTS = new Set(["path", "node:path"]);
const POSIX_REQUESTS = new Set(["path/posix", "node:path/posix"]);
const PATH_FUNCTIONS = new Set([
  "resolve", "normalize", "isAbsolute", "join", "relative", "dirname", "basename", "extname",
  "parse", "format", "toNamespacedPath", "_makeLong",
]);
const PATH_CONSTANTS = new Set(["sep", "delimiter"]);
const NODE_GLOBALS = new Set(["process", "Buffer", "global", "setImmediate", "clearImmediate", "__atoolsNodeModuleRequire"]);

export type PluginNativePathUsage = {
  kind: "safe" | "requires-node" | "unknown";
  reason?: string;
};

type PathRoot = "path" | "posix";
type AliasBinding =
  | { name: string; kind: "module"; root: PathRoot; definition: number }
  | { name: string; kind: "method"; definition: number }
  | { name: string; kind: "constant"; definition: number };

/**
 * Conservatively proves a narrow CommonJS path subset can use the local POSIX adapter.
 * It never executes source; unsupported or ambiguous syntax must keep the Node fallback.
 */
export function analyzePluginNativePathUsage(source: string): PluginNativePathUsage {
  if (source.length > MAX_SOURCE_UNITS || utf8LengthExceeds(source, MAX_SOURCE_BYTES)) {
    return { kind: "unknown", reason: "source-budget" };
  }

  const analysis = analyzePluginSource(source, { includeTokens: true });
  if (analysis.tokenBudgetExceeded || (analysis.tokens?.length ?? 0) > MAX_TOKENS) {
    return { kind: "unknown", reason: "token-budget" };
  }
  const tokens = analysis.tokens ?? [];
  const unknownReasons: string[] = [];
  const nodeReasons: string[] = [];
  const unknown = (reason: string) => { if (!unknownReasons.includes(reason)) unknownReasons.push(reason); };
  const requiresNode = (reason: string) => { if (!nodeReasons.includes(reason)) nodeReasons.push(reason); };

  if (tokens.some(token => token.kind === "template")) unknown("template");
  if (tokens.some(token => !token.literal && token.value === "\\")) unknown("escaped-identifier");
  for (const token of tokens) {
    if (!token.literal && ["eval", "Function", "constructor", "with", "import", "export", "delete", "++", "--"].includes(token.value)) {
      unknown("dynamic-code-or-esm");
    }
    if (!token.literal && NODE_GLOBALS.has(token.value)) requiresNode("node-environment-global");
  }

  const significant = (token: PluginSourceToken | undefined) => !!token && !token.literal && token.kind !== "template";
  const isWord = (token: PluginSourceToken | undefined): boolean =>
    !!token && significant(token) && /^[\w$\u0080-\uffff]+$/.test(token.value);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== "[") continue;
    const previous = tokens[index - 1];
    if (isWord(previous) || !!previous?.literal || ["?", ")", "]", "}"].includes(previous?.value ?? "")) {
      unknown("computed-member");
    }
  }
  const directRequires = new Map<number, { specifier: string; root?: PathRoot }>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!significant(token) || token.value !== "require") continue;
    if ([".", "#"].includes(tokens[index - 1]?.value ?? "")) {
      unknown("require-alias-or-property");
      continue;
    }
    if (tokens[index + 1]?.value !== "(" || !tokens[index + 2]?.stringLiteral || tokens[index + 3]?.value !== ")") {
      unknown("dynamic-or-aliased-require");
      continue;
    }
    const specifier = tokens[index + 2].value;
    const root = PATH_REQUESTS.has(specifier) ? "path"
      : POSIX_REQUESTS.has(specifier) ? "posix" : undefined;
    directRequires.set(index, { specifier, root });
  }

  const depths = tokenDepths(tokens);
  const bindings: AliasBinding[] = [];
  const definitionIndexes = new Set<number>();
  const propertyKeyIndexes = new Set<number>();
  const consumedPathRequires = new Set<number>();
  const bindingNames = new Set<string>();
  const recognizedPathDestructuringCloses = new Set<number>();
  const addBinding = (binding: AliasBinding) => {
    if (bindings.length >= MAX_ALIASES) { unknown("alias-budget"); return; }
    if (bindingNames.has(binding.name)) unknown("duplicate-or-shadowed-binding");
    bindingNames.add(binding.name);
    bindings.push(binding);
    definitionIndexes.add(binding.definition);
  };

  function isTopLevel(index: number) {
    const depth = depths[index];
    return depth.braces === 0 && depth.parens === 0 && depth.brackets === 0;
  }
  function hasDeclarationEnd(index: number) {
    const next = tokens[index + 4];
    if (!next || next.value === ";" || next.value === ",") return true;
    return source.slice(tokens[index + 3].end, next.start).includes("\n") && isWord(next);
  }
  function memberStatus(root: PathRoot, memberIndex: number): "safe" | "requires-node" | "unknown" {
    const member = tokens[memberIndex];
    if (!isWord(member)) return "unknown";
    if (member.value === "win32" || member.value === "matchesGlob") return "requires-node";
    if (PATH_FUNCTIONS.has(member.value)) return tokens[memberIndex + 1]?.value === "(" ? "safe" : "unknown";
    if (PATH_CONSTANTS.has(member.value)) return isWriteTarget(tokens, memberIndex) ? "unknown" : "safe";
    // path.posix is an implemented namespace only on the root path module.
    if (member.value === "posix" && root === "path") {
      if (tokens[memberIndex + 1]?.value !== ".") return "unknown";
      return memberStatus("posix", memberIndex + 2);
    }
    return "requires-node";
  }
  function directMemberStatus(callIndex: number, root: PathRoot): "safe" | "requires-node" | "unknown" {
    const dot = callIndex + 4;
    if (tokens[dot]?.value !== ".") return "unknown";
    return memberStatus(root, dot + 1);
  }

  // Only top-level const declarations establish reusable aliases. Everything else stays unknown.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== "const" || !isTopLevel(index)) continue;

    const next = tokens[index + 1];
    if (isWord(next) && tokens[index + 2]?.value === "=") {
      const callIndex = index + 3;
      const required = directRequires.get(callIndex);
      if (!required?.root) continue;
      if (!hasDeclarationEnd(callIndex)) { unknown("unproven-declaration"); continue; }
      addBinding({ name: next.value, kind: "module", root: required.root, definition: index + 1 });
      consumedPathRequires.add(callIndex);
      continue;
    }

    if (next?.value !== "{") continue;
    const parsed = parseDestructuring(tokens, index + 2);
    if (!parsed) continue;
    const equals = parsed.closeIndex + 1;
    const callIndex = equals + 1;
    const required = directRequires.get(callIndex);
    if (tokens[equals]?.value !== "=" || !required?.root) continue;
    if (!hasDeclarationEnd(callIndex)) { unknown("unproven-declaration"); continue; }
    consumedPathRequires.add(callIndex);
    recognizedPathDestructuringCloses.add(parsed.closeIndex);
    for (const property of parsed.properties) {
      propertyKeyIndexes.add(property.keyIndex);
      const root = required.root === "path" && property.key === "posix" ? "posix" : undefined;
      if (PATH_FUNCTIONS.has(property.key)) {
        addBinding({ name: property.binding, kind: "method", definition: property.bindingIndex });
      } else if (PATH_CONSTANTS.has(property.key)) {
        addBinding({ name: property.binding, kind: "constant", definition: property.bindingIndex });
      } else if (root) {
        addBinding({ name: property.binding, kind: "module", root, definition: property.bindingIndex });
      } else if (property.key === "win32" || property.key === "matchesGlob" || property.key === "posix") {
        requiresNode("unsupported-member");
      } else {
        // A static member outside the local adapter allowlist must keep the real Node module.
        requiresNode("unsupported-member");
      }
    }
  }

  // Other closing delimiters before an assignment or for-in/of target may hide a
  // destructuring write to a path constant; avoid trying to parse arbitrary patterns.
  for (let index = 0; index < tokens.length; index++) {
    if (!["}", "]"].includes(tokens[index].value) || recognizedPathDestructuringCloses.has(index)) continue;
    let next = index + 1;
    while (tokens[next]?.value === ")") next++;
    if (["=", "in", "of"].includes(tokens[next]?.value ?? "")) unknown("destructuring-write-target");
  }

  function bindingUseStatus(binding: AliasBinding, index: number): "safe" | "requires-node" | "unknown" {
    if (binding.kind === "method") return tokens[index + 1]?.value === "(" ? "safe" : "unknown";
    if (binding.kind === "constant") return isWriteTarget(tokens, index) ? "unknown" : "safe";
    if (tokens[index + 1]?.value !== ".") return "unknown";
    const member = tokens[index + 2]?.value;
    if (member === "posix" && binding.root === "path") {
      if (tokens[index + 3]?.value !== ".") return "unknown";
      return memberStatus("posix", index + 4);
    }
    return memberStatus(binding.root, index + 2);
  }

  for (const binding of bindings) {
    const allowedReferences = new Set<number>([binding.definition]);
    for (let index = 0; index < tokens.length; index++) {
      if (!significant(tokens[index]) || tokens[index].value !== binding.name || definitionIndexes.has(index)) continue;
      if ([".", "#"].includes(tokens[index - 1]?.value ?? "")) continue;
      if (propertyKeyIndexes.has(index)) continue;
      const status = bindingUseStatus(binding, index);
      if (status === "safe" || status === "requires-node") allowedReferences.add(index);
      else unknown(binding.kind === "module" ? "module-object-escape" : "alias-escape");
      if (status === "requires-node") requiresNode("unsupported-member");
    }
    // This catches shadowed declarations and any same-name use not recognized above.
    for (let index = 0; index < tokens.length; index++) {
      if (significant(tokens[index]) && tokens[index].value === binding.name
        && ![".", "#"].includes(tokens[index - 1]?.value ?? "")
        && !propertyKeyIndexes.has(index) && !allowedReferences.has(index)) {
        unknown("duplicate-or-shadowed-binding");
      }
    }
  }

  // Any path require must be either a recognized top-level alias or a direct static member use.
  for (const [index, required] of directRequires) {
    if (!required.root || consumedPathRequires.has(index)) continue;
    const status = directMemberStatus(index, required.root);
    if (status === "unknown") unknown("module-object-escape-or-computed-member");
    if (status === "requires-node") requiresNode("unsupported-member");
  }

  if (unknownReasons.length) return { kind: "unknown", reason: unknownReasons[0] };
  if (nodeReasons.length) return { kind: "requires-node", reason: nodeReasons[0] };
  return { kind: "safe" };
}

function parseDestructuring(tokens: PluginSourceToken[], startIndex: number): {
  closeIndex: number;
  properties: { key: string; keyIndex: number; binding: string; bindingIndex: number }[];
} | undefined {
  const properties: { key: string; keyIndex: number; binding: string; bindingIndex: number }[] = [];
  let index = startIndex;
  while (index < tokens.length && tokens[index].value !== "}") {
    const key = tokens[index];
    if (!isStaticIdentifier(key) || key.value === "..." || key.value === "[") return undefined;
    const keyIndex = index;
    if (tokens[index + 1]?.value === ":") {
      const binding = tokens[index + 2];
      if (!isStaticIdentifier(binding)) return undefined;
      properties.push({ key: key.value, keyIndex, binding: binding.value, bindingIndex: index + 2 });
      index += 3;
    } else {
      properties.push({ key: key.value, keyIndex, binding: key.value, bindingIndex: keyIndex });
      index++;
    }
    if (tokens[index]?.value === ",") index++;
    else if (tokens[index]?.value !== "}") return undefined;
  }
  return tokens[index]?.value === "}" ? { closeIndex: index, properties } : undefined;
}

function isStaticIdentifier(token: PluginSourceToken | undefined): token is PluginSourceToken {
  return !!token && !token.literal && token.kind !== "template" && /^[\w$\u0080-\uffff]+$/.test(token.value);
}

function isWriteTarget(tokens: PluginSourceToken[], index: number): boolean {
  const before = tokens[index - 1]?.value, after = tokens[index + 1]?.value;
  if (["++", "--", "delete"].includes(before ?? "") || tokens[index - 2]?.value === "delete"
    || ["++", "--", "in", "of"].includes(after ?? "")) return true;
  if ((after === "]" || after === "}") && ["=", "in", "of"].includes(tokens[index + 2]?.value ?? "")) return true;
  if (after === "}" || after === "]") {
    let close = index + 1;
    while (["}", "]", ")"].includes(tokens[close]?.value ?? "")) close++;
    if (["=", "in", "of"].includes(tokens[close]?.value ?? "")) return true;
  }
  if (after === "=" && tokens[index + 2]?.value !== "=") return true;
  let operatorEnd = index + 1;
  while (operatorEnd <= index + 3 && ["+", "-", "*", "/", "%", "|", "&", "^", "<", ">", "?"].includes(tokens[operatorEnd]?.value ?? "")) {
    operatorEnd++;
  }
  if (operatorEnd > index + 1 && tokens[operatorEnd]?.value === "=") return true;
  if ((after === "}" || after === "]") && tokens[index + 2]?.value === ")" && tokens[index + 3]?.value === "=") return true;
  return false;
}

function tokenDepths(tokens: PluginSourceToken[]) {
  let braces = 0, parens = 0, brackets = 0;
  return tokens.map(token => {
    if (!token.literal && token.value === "}") braces = Math.max(0, braces - 1);
    if (!token.literal && token.value === ")") parens = Math.max(0, parens - 1);
    if (!token.literal && token.value === "]") brackets = Math.max(0, brackets - 1);
    const depth = { braces, parens, brackets };
    if (!token.literal && token.kind !== "template") {
      if (token.value === "{") braces++;
      if (token.value === "(") parens++;
      if (token.value === "[") brackets++;
    }
    return depth;
  });
}

function utf8LengthExceeds(source: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length
      && source.charCodeAt(index + 1) >= 0xdc00 && source.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}
