export type PluginSourceAnalysis = {
  requires: string[];
  imports: { start: number; end: number; literal?: string }[];
  staticDependencies: boolean;
  importMeta: boolean;
  moduleSpecifiers?: { start: number; end: number; value: string; kind: "static" | "dynamic" }[];
  automaticPublicPathFallbacks?: { start: number; end: number }[];
  tokens?: PluginSourceToken[];
  tokenBudgetExceeded?: true;
};

export type PluginSourceToken = {
  value: string;
  start: number;
  end: number;
  literal?: boolean;
  stringLiteral?: boolean;
  method?: boolean;
  kind?: "template";
};

export type PluginSourceAnalysisOptions = {
  includeModuleSpecifiers?: boolean;
  includeAutomaticPublicPathFallbacks?: boolean;
  includeTokens?: boolean;
};

/** Small lexical scan shared by preload preparation and the serialized ESM loader. */
export function analyzePluginSource(source: string, options: PluginSourceAnalysisOptions = {}): PluginSourceAnalysis {
  type Token = PluginSourceToken;
  const tokens: Token[] = [];
  const templateTokens: Token[] = [];
  const tokenLimit = options.includeTokens ? 16_384 : Number.POSITIVE_INFINITY;
  let tokenBudgetExceeded = false;
  let tokenCount = 0;
  function pushToken(token: Token) {
    if (tokenCount >= tokenLimit) { tokenBudgetExceeded = true; return; }
    tokenCount++;
    tokens.push(token);
  }
  function pushTemplateToken(token: Token) {
    if (tokenCount >= tokenLimit) { tokenBudgetExceeded = true; return; }
    tokenCount++;
    templateTokens.push(token);
  }
  const expressionWords = new Set(["return", "throw", "case", "delete", "void", "typeof", "new", "yield", "await", "in", "of", "else", "do", "default"]);
  const controlWords = new Set(["if", "while", "for", "with", "switch", "catch"]);
  function quoted(start: number): Token {
    const quote = source[start]; let index = start + 1, value = "";
    while (index < source.length) {
      let char = source[index++];
      if (char === quote) break;
      if (char !== "\\") { value += char; continue; }
      char = source[index++];
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (char in escapes) value += escapes[char];
      else if (char === "\n") continue;
      else if (char === "\r") { if (source[index] === "\n") index++; }
      else if (char === "x" || char === "u") {
        const width = char === "x" ? 2 : 4;
        const match = char === "u" && source[index] === "{" ? /^\{([\da-f]+)\}/i.exec(source.slice(index)) : null;
        const hex = match ? match[1] : source.slice(index, index + width);
        if (/^[\da-f]+$/i.test(hex)) {
          value += String.fromCodePoint(parseInt(hex, 16)); index += match ? match[0].length : width;
        } else value += char;
      } else value += char;
    }
    return { value, start, end: index, literal: true, stringLiteral: true };
  }
  function regex(index: number): number {
    let bracket = false; index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === "\\") index++;
      else if (char === "[") bracket = true;
      else if (char === "]") bracket = false;
      else if (char === "/" && !bracket) { while (/[a-z]/i.test(source[index] ?? "")) index++; return index; }
      else if (char === "\n" || char === "\r") return index;
    }
    return index;
  }
  function template(start: number): number {
    let index = start + 1, literal = true;
    while (index < source.length) {
      if (tokenBudgetExceeded) return index;
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") {
        if (literal) pushToken({ value: source.slice(start + 1, index), start, end: index + 1,
          literal: !source.slice(start + 1, index).includes("\\"), ...(options.includeTokens ? { kind: "template" as const } : {}) });
        else if (options.includeTokens) pushTemplateToken({ value: "", start, end: index + 1, literal: true, kind: "template" });
        return index + 1;
      }
      if (source.startsWith("${", index)) { literal = false; index = code(index + 2, true); }
      else index++;
    }
    if (options.includeTokens) {
      const token = { value: source.slice(start + 1, index), start, end: index, literal: true, kind: "template" as const };
      if (literal) pushToken(token); else pushTemplateToken({ ...token, value: "" });
    }
    return index;
  }
  function code(index: number, interpolation = false): number {
    let braces = 0, operand = true;
    const parentheses: { control: boolean; functionExpression?: boolean }[] = [];
    const blocks: boolean[] = [];
    const methodBodies: boolean[] = [];
    let pendingFunction: boolean | undefined, closedFunction: boolean | undefined, pendingClass: boolean | undefined;
    let previous = "";
    while (index < source.length) {
      if (tokenBudgetExceeded) return index;
      const char = source[index];
      if (/\s/.test(char)) { index++; continue; }
      if (source.startsWith("//", index)) { const end = source.indexOf("\n", index + 2); index = end < 0 ? source.length : end + 1; continue; }
      if (source.startsWith("/*", index)) { const end = source.indexOf("*/", index + 2); index = end < 0 ? source.length : end + 2; continue; }
      if (char === "'" || char === '"') { const token = quoted(index); pushToken(token); index = token.end; operand = false; previous = "literal"; continue; }
      if (char === "`") { index = template(index); operand = false; previous = "literal"; continue; }
      if (char === "/" && operand) { index = regex(index); operand = false; previous = "literal"; continue; }
      if (source.startsWith("++", index) || source.startsWith("--", index)) {
        previous = source.slice(index, index + 2); pushToken({ value: previous, start: index, end: index + 2 });
        index += 2; continue; // Prefix still needs an operand; postfix still has one.
      }
      if (source.startsWith("=>", index)) { pushToken({ value: "=>", start: index, end: index + 2 }); previous = "=>"; operand = true; index += 2; continue; }
      if (/[\w$\u0080-\uffff]/.test(char)) {
        const start = index++;
        while (/[\w$\u0080-\uffff]/.test(source[index] ?? "")) index++;
        const word = source.slice(start, index);
        const before = previous === "async" ? tokens[tokens.length - 2]?.value : previous;
        const expression = ["=", "(", "[", ",", ":", "return", "=>"].includes(before || "");
        if (word === "function") pendingFunction = expression;
        if (word === "class") pendingClass = expression;
        const method = word === "import" && methodBodies[methodBodies.length - 1]
          && ["{", ",", "}", ";", "async", "get", "set", "static", "*"].includes(previous);
        previous = word;
        pushToken({ value: previous, start, end: index, ...(method ? { method: true } : {}) });
        operand = before !== "." && before !== "#" && expressionWords.has(previous); continue;
      }
      if (char === "}" && interpolation && braces === 0) return index + 1;
      if (char === "{") {
        methodBodies.push(pendingClass !== undefined || (closedFunction === undefined && ["=", "(", "[", ",", ":", "return"].includes(previous)));
        braces++; blocks.push(previous === "=>" ? false : closedFunction !== undefined ? !closedFunction
          : pendingClass !== undefined ? !pendingClass : !["=", "(", "[", ",", ":", "return"].includes(previous));
        pendingClass = undefined;
      }
      const closingBlock = char === "}" && blocks.pop();
      if (char === "}") { braces--; methodBodies.pop(); }
      if (char === "(") { parentheses.push({ control: controlWords.has(previous), ...(pendingFunction !== undefined ? { functionExpression: pendingFunction } : {}) }); pendingFunction = undefined; }
      const closing = char === ")" ? parentheses.pop() : undefined;
      closedFunction = closing?.functionExpression;
      pushToken({ value: char, start: index, end: index + 1 });
      operand = char === ")" ? !!closing?.control : char === "}" ? !!closingBlock : !["]", "."].includes(char);
      previous = char; index++;
    }
    return index;
  }
  function findFromSpecifier(start: number) {
    let nesting = 0;
    for (let index = start; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.value === "{" || token.value === "[" || token.value === "(") nesting++;
      else if (token.value === "}" || token.value === "]" || token.value === ")") nesting = Math.max(0, nesting - 1);
      if (nesting === 0 && token.value === ";") return undefined;
      if (nesting === 0 && (token.value === "import" || token.value === "export")) return undefined;
      if (nesting === 0 && token.value === "from" && tokens[index + 1]?.stringLiteral) return tokens[index + 1];
    }
    return undefined;
  }
  function onlyTrivia(start: number, end: number): boolean {
    while (start < end) {
      if (/\s/.test(source[start])) { start++; continue; }
      if (source.startsWith("//", start)) {
        const newline = source.indexOf("\n", start + 2);
        start = newline < 0 ? end : newline + 1; continue;
      }
      if (source.startsWith("/*", start)) {
        const closing = source.indexOf("*/", start + 2);
        if (closing < 0 || closing + 2 > end) return false;
        start = closing + 2; continue;
      }
      return false;
    }
    return start === end;
  }
  function automaticPublicPathFallback(index: number): { start: number; end: number } | undefined {
    const syntax = ["if", "(", "!", "e", ")", "throw", "new", "Error", "(", null, ")", ";"];
    for (let offset = 0; offset < syntax.length; offset++) {
      const token = tokens[index + offset];
      if (!token) return undefined;
      if (offset === 9) {
        if (!token.stringLiteral || token.value !== "Automatic publicPath is not supported in this browser") return undefined;
      } else if (token.literal || token.value !== syntax[offset]) return undefined;
      // The lexer omits regex/template text. Such text cannot bridge statement tokens.
      if (offset && !onlyTrivia(tokens[index + offset - 1].end, token.start)) return undefined;
    }
    // A line terminator after throw is forbidden even inside a block comment.
    if (/[\r\n\u2028\u2029]/.test(source.slice(tokens[index + 5].end, tokens[index + 6].start))) return undefined;
    return { start: tokens[index].start, end: tokens[index + syntax.length - 1].end };
  }
  code(0);
  const result: PluginSourceAnalysis = { requires: [], imports: [], staticDependencies: false, importMeta: false };
  const moduleSpecifiers: NonNullable<PluginSourceAnalysis["moduleSpecifiers"]> = [];
  const automaticPublicPathFallbacks: NonNullable<PluginSourceAnalysis["automaticPublicPathFallbacks"]> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], before = tokens[index - 1]?.value, next = tokens[index + 1]?.value;
    if (token.literal || before === "." || before === "#") continue;
    if (options.includeAutomaticPublicPathFallbacks && token.value === "if") {
      const fallback = automaticPublicPathFallback(index);
      if (fallback) automaticPublicPathFallbacks.push(fallback);
    }
    if (token.value === "require" && next === "(" && tokens[index + 2]?.literal && tokens[index + 3]?.value === ")") {
      if (!result.requires.includes(tokens[index + 2].value)) result.requires.push(tokens[index + 2].value);
    }
    if (token.value === "import") {
      if (next === ".") { result.importMeta = true; continue; }
      if (next !== "(") {
        if (next !== ":") {
          result.staticDependencies = true;
          if (options.includeModuleSpecifiers) {
            const specifier = tokens[index + 1]?.stringLiteral ? tokens[index + 1] : findFromSpecifier(index + 1);
            if (specifier?.stringLiteral) moduleSpecifiers.push({ start: specifier.start, end: specifier.end, value: specifier.value, kind: "static" });
          }
        }
        continue;
      }
      let depth = 0, end = index + 1;
      for (; end < tokens.length; end++) {
        if (tokens[end].literal) continue;
        if (tokens[end].value === "(") depth++;
        if (tokens[end].value === ")" && --depth === 0) break;
      }
      if (token.method && tokens[end + 1]?.value === "{") continue;
      result.imports.push({ start: token.start, end: token.end,
        ...(tokens[index + 2]?.literal && tokens[index + 3]?.value === ")" ? { literal: tokens[index + 2].value } : {}) });
      if (options.includeModuleSpecifiers && tokens[index + 2]?.stringLiteral && tokens[index + 3]?.value === ")") {
        const specifier = tokens[index + 2];
        moduleSpecifiers.push({ start: specifier.start, end: specifier.end, value: specifier.value, kind: "dynamic" });
      }
    }
    if (token.value === "export" && next === "*") {
      result.staticDependencies = true;
      if (options.includeModuleSpecifiers) {
        let from = index + 2;
        while (from < tokens.length && !(tokens[from].value === "from" && tokens[from + 1]?.stringLiteral) && tokens[from].value !== ";") from++;
        if (tokens[from]?.value === "from" && tokens[from + 1]?.stringLiteral) {
          const specifier = tokens[from + 1];
          moduleSpecifiers.push({ start: specifier.start, end: specifier.end, value: specifier.value, kind: "static" });
        }
      }
    }
    if (token.value === "export" && next === "{") {
      let end = index + 2; while (end < tokens.length && tokens[end].value !== "}") end++;
      if (tokens[end + 1]?.value === "from") {
        result.staticDependencies = true;
        if (options.includeModuleSpecifiers && tokens[end + 2]?.stringLiteral) {
          const specifier = tokens[end + 2];
          moduleSpecifiers.push({ start: specifier.start, end: specifier.end, value: specifier.value, kind: "static" });
        }
      }
    }
  }
  if (options.includeModuleSpecifiers) {
    const unique = new Map(moduleSpecifiers.map((specifier) => [`${specifier.start}:${specifier.end}`, specifier]));
    result.moduleSpecifiers = [...unique.values()];
  }
  if (options.includeAutomaticPublicPathFallbacks) result.automaticPublicPathFallbacks = automaticPublicPathFallbacks;
  if (options.includeTokens) {
    result.tokens = [...tokens, ...templateTokens].sort((left, right) => left.start - right.start || right.end - left.end);
    if (tokenBudgetExceeded) result.tokenBudgetExceeded = true;
  }
  return result;
}

export function rewritePluginImports(source: string, parent: string): string {
  for (const call of analyzePluginSource(source).imports.reverse()) {
    source = source.slice(0, call.start) + `window.__atoolsImportModule.bind(null,${JSON.stringify(parent)})` + source.slice(call.end);
  }
  return source;
}
