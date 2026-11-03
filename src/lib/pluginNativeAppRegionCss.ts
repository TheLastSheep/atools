export type PluginNativeAppRegionCssMode = "stylesheet" | "declarations";
export type PluginNativeAppRegionCssRewriter = (css: string, mode?: PluginNativeAppRegionCssMode) => string;

/** A self-contained factory whose source can also be serialized into the plugin bridge. */
export function createPluginNativeAppRegionCss(): PluginNativeAppRegionCssRewriter {
  const privateProperty = "--atools-native-app-region";
  const maxNestingDepth = 64;
  const cssWideKeywords = ["inherit", "initial", "unset", "revert", "revert-layer"];
  const declarationAtRules = ["font-face", "page", "counter-style", "property", "font-palette-values", "font-feature-values", "viewport", "-ms-viewport"];

  function isWhitespace(char: string): boolean {
    return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
  }

  function isHex(char: string): boolean {
    return /^[0-9a-f]$/i.test(char);
  }

  function skipEscape(source: string, index: number, end: number): number {
    let cursor = index + 1;
    if (cursor >= end) return cursor;
    if (source[cursor] === "\r") return source[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
    if (source[cursor] === "\n" || source[cursor] === "\f") return cursor + 1;
    if (!isHex(source[cursor] ?? "")) return cursor + 1;
    let count = 0;
    while (cursor < end && count < 6 && isHex(source[cursor] ?? "")) { cursor++; count++; }
    if (cursor < end && isWhitespace(source[cursor] ?? "")) {
      if (source[cursor] === "\r" && source[cursor + 1] === "\n") return cursor + 2;
      return cursor + 1;
    }
    return cursor;
  }

  function findBoundary(source: string, start: number, end: number): { index: number; char: string } | null {
    let quote = "", parentheses = 0, brackets = 0;
    for (let cursor = start; cursor < end; cursor++) {
      const char = source[cursor] ?? "";
      if (quote) {
        if (char === "\\") { cursor = skipEscape(source, cursor, end) - 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === "/" && source[cursor + 1] === "*") {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0 || close >= end) return null;
        cursor = close + 1;
        continue;
      }
      if (char === "\\") { cursor = skipEscape(source, cursor, end) - 1; continue; }
      if (char === "\"" || char === "'") { quote = char; continue; }
      if (char === "(") { parentheses++; continue; }
      if (char === ")" && parentheses > 0) { parentheses--; continue; }
      if (char === "[") { brackets++; continue; }
      if (char === "]" && brackets > 0) { brackets--; continue; }
      if (parentheses || brackets) continue;
      if (char === ";" || char === "{" || char === "}") return { index: cursor, char };
    }
    return null;
  }

  function skipTrivia(source: string, start: number, end: number): number {
    let cursor = start;
    while (cursor < end) {
      if (isWhitespace(source[cursor] ?? "")) { cursor++; continue; }
      if (source[cursor] === "/" && source[cursor + 1] === "*") {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0 || close >= end) return end;
        cursor = close + 2;
        continue;
      }
      break;
    }
    return cursor;
  }

  function decodeIdentifier(raw: string): string | null {
    let output = "";
    for (let cursor = 0; cursor < raw.length;) {
      const char = raw[cursor] ?? "";
      if (char === "\\") {
        const next = cursor + 1;
        if (next >= raw.length || raw[next] === "\n" || raw[next] === "\r" || raw[next] === "\f") return null;
        if (isHex(raw[next] ?? "")) {
          let end = next, digits = "";
          while (end < raw.length && digits.length < 6 && isHex(raw[end] ?? "")) { digits += raw[end]; end++; }
          const codePoint = Number.parseInt(digits, 16);
          output += !codePoint || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? "\uFFFD"
            : String.fromCodePoint(codePoint);
          if (end < raw.length && isWhitespace(raw[end] ?? "")) {
            if (raw[end] === "\r" && raw[end + 1] === "\n") end++;
            end++;
          }
          cursor = end;
          continue;
        }
        output += raw[next];
        cursor += 2;
        continue;
      }
      if (!/[a-z0-9_-]/i.test(char) && char.charCodeAt(0) < 0x80) return null;
      output += char;
      cursor++;
    }
    return output;
  }

  function declarationName(source: string, colon: number): { start: number; end: number; name: string } | null {
    const nameStart = skipTrivia(source, 0, colon);
    let cursor = nameStart;
    while (cursor < colon) {
      const char = source[cursor] ?? "";
      if (char === "\\") { cursor = skipEscape(source, cursor, colon); continue; }
      if (/[a-z0-9_-]/i.test(char) || char.charCodeAt(0) >= 0x80) { cursor++; continue; }
      break;
    }
    if (cursor === nameStart) return null;
    const raw = source.slice(nameStart, cursor);
    const name = decodeIdentifier(raw);
    if (name == null || skipTrivia(source, cursor, colon) !== colon) return null;
    return { start: nameStart, end: cursor, name: name.toLowerCase() };
  }

  function removeComments(source: string): string {
    let output = "", quote = "";
    for (let cursor = 0; cursor < source.length; cursor++) {
      const char = source[cursor] ?? "";
      if (quote) {
        output += char;
        if (char === "\\" && cursor + 1 < source.length) output += source[++cursor];
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") { quote = char; output += char; continue; }
      if (char === "/" && source[cursor + 1] === "*") {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0) return source;
        output += " ";
        cursor = close + 1;
        continue;
      }
      output += char;
    }
    return output;
  }

  function isVarExpression(value: string): boolean {
    if (!/^var\s*\(/i.test(value)) return false;
    const open = value.indexOf("(");
    let quote = "", depth = 1, comma = -1;
    for (let cursor = open + 1; cursor < value.length; cursor++) {
      const char = value[cursor] ?? "";
      if (quote) {
        if (char === "\\") cursor++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") { quote = char; continue; }
      if (char === "/" && value[cursor + 1] === "*") {
        const close = value.indexOf("*/", cursor + 2);
        if (close < 0) return false;
        cursor = close + 1;
        continue;
      }
      if (char === "\\") { cursor = skipEscape(value, cursor, value.length) - 1; continue; }
      if (char === "(") depth++;
      else if (char === ")" && --depth === 0) {
        if (value.slice(cursor + 1).trim()) return false;
        const argumentsText = value.slice(open + 1, cursor);
        const first = (comma < 0 ? argumentsText : argumentsText.slice(0, comma)).trim();
        return /^--(?:[\w-]|\\.)+$/u.test(first);
      } else if (char === "," && depth === 1 && comma < 0) comma = cursor - open - 1;
    }
    return false;
  }

  function supportedValue(raw: string): boolean {
    let value = removeComments(raw).trim();
    value = value.replace(/!\s*important\s*$/i, "").trim().toLowerCase();
    return value === "drag" || value === "no-drag" || value === "none"
      || cssWideKeywords.includes(value) || isVarExpression(value);
  }

  function rewriteDeclaration(source: string): string {
    const colon = findValueColon(source);
    if (colon < 0) return source;
    const property = declarationName(source, colon);
    if (!property || (property.name !== "app-region" && property.name !== "-webkit-app-region")) return source;
    if (!supportedValue(source.slice(colon + 1))) return source;
    return source.slice(0, property.start) + privateProperty + source.slice(property.end);
  }

  function findValueColon(source: string): number {
    let quote = "", parentheses = 0, brackets = 0;
    for (let cursor = 0; cursor < source.length; cursor++) {
      const char = source[cursor] ?? "";
      if (quote) {
        if (char === "\\") { cursor = skipEscape(source, cursor, source.length) - 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === "/" && source[cursor + 1] === "*") {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0) return -1;
        cursor = close + 1;
        continue;
      }
      if (char === "\\") { cursor = skipEscape(source, cursor, source.length) - 1; continue; }
      if (char === "\"" || char === "'") { quote = char; continue; }
      if (char === "(") { parentheses++; continue; }
      if (char === ")" && parentheses > 0) { parentheses--; continue; }
      if (char === "[") { brackets++; continue; }
      if (char === "]" && brackets > 0) { brackets--; continue; }
      if (char === ":" && !parentheses && !brackets) return cursor;
      if (char === ";" && !parentheses && !brackets) return -1;
    }
    return -1;
  }

  function isDeclarationAtRule(prelude: string): boolean {
    const match = /^\s*@([\w-]+)/.exec(removeComments(prelude));
    return !!match && declarationAtRules.includes(match[1].toLowerCase());
  }

  function isAtRule(prelude: string): boolean {
    return /^\s*@/.test(removeComments(prelude));
  }

  type ParseResult = { text: string; next: number; closed: boolean };

  function skipOpaqueBlock(source: string, open: number, end: number): number {
    let depth = 1, quote = "", parentheses = 0, brackets = 0;
    for (let cursor = open + 1; cursor < end; cursor++) {
      const char = source[cursor] ?? "";
      if (quote) {
        if (char === "\\") { cursor = skipEscape(source, cursor, end) - 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === "/" && source[cursor + 1] === "*") {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0 || close >= end) return -1;
        cursor = close + 1;
        continue;
      }
      if (char === "\\") { cursor = skipEscape(source, cursor, end) - 1; continue; }
      if (char === "\"" || char === "'") { quote = char; continue; }
      if (char === "(") { parentheses++; continue; }
      if (char === ")" && parentheses > 0) { parentheses--; continue; }
      if (char === "[") { brackets++; continue; }
      if (char === "]" && brackets > 0) { brackets--; continue; }
      if (parentheses || brackets) continue;
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return cursor;
    }
    return -1;
  }

  function rewriteDeclarations(source: string, start: number, end: number, expectClosing: boolean): ParseResult {
    let cursor = start, output = "";
    while (cursor < end) {
      const boundary = findBoundary(source, cursor, end);
      if (!boundary) return { text: output + rewriteDeclaration(source.slice(cursor, end)), next: end, closed: !expectClosing };
      if (boundary.char === ";") {
        output += rewriteDeclaration(source.slice(cursor, boundary.index)) + ";";
        cursor = boundary.index + 1;
      } else if (boundary.char === "}") {
        return expectClosing
          ? { text: output + rewriteDeclaration(source.slice(cursor, boundary.index)), next: boundary.index, closed: true }
          : { text: output + source.slice(cursor, end), next: end, closed: false };
      } else {
        return { text: output + source.slice(cursor, end), next: end, closed: false };
      }
    }
    return { text: output, next: end, closed: !expectClosing };
  }

  function rewriteChildBlock(source: string, prelude: string, start: number, end: number, depth: number): ParseResult {
    if (depth >= maxNestingDepth) {
      const close = skipOpaqueBlock(source, start - 1, end);
      if (close < 0) return { text: source.slice(start, end), next: end, closed: false };
      return { text: source.slice(start, close), next: close, closed: true };
    }
    if (isAtRule(prelude)) {
      return isDeclarationAtRule(prelude)
        ? rewriteDeclarations(source, start, end, true)
        : rewriteRuleList(source, start, end, true, depth + 1);
    }
    return rewriteMixedBlock(source, start, end, true, depth + 1);
  }

  function rewriteRuleList(source: string, start: number, end: number, expectClosing: boolean, depth = 0): ParseResult {
    let cursor = start, output = "";
    while (cursor < end) {
      const boundary = findBoundary(source, cursor, end);
      if (!boundary) return { text: output + source.slice(cursor, end), next: end, closed: !expectClosing };
      if (boundary.char === ";") {
        output += source.slice(cursor, boundary.index + 1);
        cursor = boundary.index + 1;
        continue;
      }
      if (boundary.char === "}") {
        return expectClosing
          ? { text: output + source.slice(cursor, boundary.index), next: boundary.index, closed: true }
          : { text: output + source.slice(cursor, end), next: end, closed: false };
      }
      const prelude = source.slice(cursor, boundary.index);
      const child = rewriteChildBlock(source, prelude, boundary.index + 1, end, depth);
      if (!child.closed) return { text: output + source.slice(cursor, end), next: end, closed: false };
      output += prelude + "{" + child.text + "}";
      cursor = child.next + 1;
    }
    return { text: output, next: end, closed: !expectClosing };
  }

  function rewriteMixedBlock(source: string, start: number, end: number, expectClosing: boolean, depth: number): ParseResult {
    let cursor = start, output = "";
    while (cursor < end) {
      const boundary = findBoundary(source, cursor, end);
      if (!boundary) return { text: output + rewriteDeclaration(source.slice(cursor, end)), next: end, closed: !expectClosing };
      if (boundary.char === ";") {
        output += rewriteDeclaration(source.slice(cursor, boundary.index)) + ";";
        cursor = boundary.index + 1;
        continue;
      }
      if (boundary.char === "}") {
        return expectClosing
          ? { text: output + rewriteDeclaration(source.slice(cursor, boundary.index)), next: boundary.index, closed: true }
          : { text: output + source.slice(cursor, end), next: end, closed: false };
      }
      const prelude = source.slice(cursor, boundary.index);
      const colon = findValueColon(prelude);
      const name = colon >= 0 ? declarationName(prelude, colon) : null;
      if (name?.name.startsWith("--")) {
        const close = skipOpaqueBlock(source, boundary.index, end);
        if (close < 0) return { text: output + source.slice(cursor, end), next: end, closed: false };
        output += source.slice(cursor, close + 1);
        cursor = close + 1;
        continue;
      }
      const child = rewriteChildBlock(source, prelude, boundary.index + 1, end, depth);
      if (!child.closed) return { text: output + source.slice(cursor, end), next: end, closed: false };
      output += prelude + "{" + child.text + "}";
      cursor = child.next + 1;
    }
    return { text: output, next: end, closed: !expectClosing };
  }

  return function rewrite(css: string, mode: PluginNativeAppRegionCssMode = "stylesheet"): string {
    const source = String(css);
    return mode === "declarations"
      ? rewriteDeclarations(source, 0, source.length, false).text
      : rewriteRuleList(source, 0, source.length, false).text;
  };
}

const rewriteCss = createPluginNativeAppRegionCss();

export function rewritePluginNativeAppRegionCss(
  css: string,
  mode: PluginNativeAppRegionCssMode = "stylesheet",
): string {
  return rewriteCss(css, mode);
}
