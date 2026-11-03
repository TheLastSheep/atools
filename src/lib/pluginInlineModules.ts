import { analyzePluginSource } from "./pluginSourceAnalysis";

export const PLUGIN_INLINE_MODULE_LIMITS = { moduleBytes: 256 * 1024, pageBytes: 2 * 1024 * 1024, dependencies: 128 } as const;

export type PluginInlineModuleState = {
  sourceBytes: number;
  references: number;
  dependencies: Set<string>;
  leases: Map<string, Promise<string>>;
};

export type PluginInlineModuleRewrite = { source: string; urls: string[]; state: PluginInlineModuleState };
export type ResolveInlineModule = (specifier: string) => string | Promise<string>;

export function isLocalPluginModuleSpecifier(specifier: string): boolean {
  if (!specifier || specifier.startsWith("#") || specifier.startsWith("//")) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier) && !/^[a-z]:[\\/]/i.test(specifier)) return false;
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || /^[a-z]:[\\/]/i.test(specifier);
}

export async function rewritePluginInlineModule(
  source: string,
  resolve: ResolveInlineModule,
  currentState?: PluginInlineModuleState,
): Promise<PluginInlineModuleRewrite | null> {
  const moduleBytes = utf8ByteLength(source, PLUGIN_INLINE_MODULE_LIMITS.moduleBytes);
  if (moduleBytes > PLUGIN_INLINE_MODULE_LIMITS.moduleBytes) throw new Error("ERR_ATOOLS_INLINE_MODULE_BUDGET");
  const state = currentState ?? { sourceBytes: 0, references: 0, dependencies: new Set<string>(), leases: new Map<string, Promise<string>>() };
  if (state.sourceBytes + moduleBytes > PLUGIN_INLINE_MODULE_LIMITS.pageBytes) throw new Error("ERR_ATOOLS_INLINE_MODULE_BUDGET");
  state.sourceBytes += moduleBytes;

  const specifiers = analyzePluginSource(source, { includeModuleSpecifiers: true }).moduleSpecifiers ?? [];
  const local = specifiers.filter((specifier) => isLocalPluginModuleSpecifier(specifier.value));
  if (!local.length) return { source, urls: [], state };
  if (state.references + local.length > PLUGIN_INLINE_MODULE_LIMITS.dependencies) throw new Error("ERR_ATOOLS_INLINE_MODULE_BUDGET");
  const newDependencies = new Set(local.map((specifier) => specifier.value).filter((value) => !state.dependencies.has(value)));
  if (state.dependencies.size + newDependencies.size > PLUGIN_INLINE_MODULE_LIMITS.dependencies) throw new Error("ERR_ATOOLS_INLINE_MODULE_BUDGET");
  state.references += local.length;

  const replacements: { start: number; end: number; value: string; url: string }[] = [];
  for (const specifier of local) {
    let lease = state.leases.get(specifier.value);
    if (!lease) {
      lease = Promise.resolve(resolve(specifier.value));
      state.leases.set(specifier.value, lease);
    }
    const url = await lease;
    if (!url) throw new Error("ERR_ATOOLS_INLINE_MODULE_RESOLUTION");
    state.dependencies.add(specifier.value);
    replacements.push({ start: specifier.start, end: specifier.end, value: javascriptString(url), url });
  }

  const urls = [...new Set(replacements.map((replacement) => replacement.url))];
  replacements.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (!Number.isInteger(replacement.start) || !Number.isInteger(replacement.end)
      || replacement.start < cursor || replacement.end <= replacement.start || replacement.end > source.length) {
      throw new Error("ERR_ATOOLS_INLINE_MODULE_SPAN");
    }
    parts.push(source.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  parts.push(source.slice(cursor));
  const rewritten = parts.join("");
  return { source: rewritten, urls, state };
}

function javascriptString(value: string): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

function utf8ByteLength(value: string, stopAfter: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}
