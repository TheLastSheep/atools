import { isOptionalRemoteFontMetadataLink } from "./optionalRemoteFontMetadata";

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "iframe", "noembed", "noframes"]);
const FOREIGN_CONTENT_ROOT_TAGS = new Set(["svg", "math"]);

type HtmlTag = { name: string; closing: boolean; end: number; selfClosing: boolean };
type TagRead = { kind: "tag"; tag: HtmlTag } | { kind: "text" } | { kind: "unterminated" };

/** Removes recognized optional font links only from active HTML markup. */
export function removeActiveOptionalRemoteFontLinks(html: string): string {
  const removals: Array<{ start: number; end: number }> = [];
  let index = 0;
  let templateDepth = 0;
  const foreignContent: string[] = [];

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const commentEnd = html.indexOf("-->", index + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    if (html[index] !== "<") { index += 1; continue; }
    if (html.startsWith("<![CDATA[", index)) {
      const cdataEnd = html.indexOf("]]>", index + 9);
      index = cdataEnd < 0 ? html.length : cdataEnd + 3;
      continue;
    }
    if (html.startsWith("<!", index) || html.startsWith("<?", index)) {
      index = findDeclarationEnd(html, index + 2);
      continue;
    }

    const parsed = readHtmlTag(html, index);
    if (parsed.kind === "text") { index += 1; continue; }
    if (parsed.kind === "unterminated") break;
    const tag = parsed.tag;
    const start = index;
    index = tag.end;

    if (tag.closing) {
      if (tag.name === "template" && templateDepth > 0) templateDepth -= 1;
      if (foreignContent[foreignContent.length - 1] === tag.name) foreignContent.pop();
      continue;
    }
    if (tag.name === "template") { templateDepth += 1; continue; }
    if (FOREIGN_CONTENT_ROOT_TAGS.has(tag.name)) {
      if (!tag.selfClosing) foreignContent.push(tag.name);
      continue;
    }
    if (tag.name === "plaintext") break;
    if (RAW_TEXT_TAGS.has(tag.name)) {
      const close = findRawTextClose(html, tag.end, tag.name);
      if (close.kind !== "found") break;
      index = close.index;
      continue;
    }
    if (tag.name === "link" && templateDepth === 0 && foreignContent.length === 0
      && isOptionalRemoteFontMetadataLink(html.slice(start, tag.end))) {
      removals.push({ start, end: tag.end });
    }
  }

  if (!removals.length) return html;
  const result: string[] = [];
  let cursor = 0;
  for (const span of removals) {
    result.push(html.slice(cursor, span.start));
    cursor = span.end;
  }
  result.push(html.slice(cursor));
  return result.join("");
}

function readHtmlTag(source: string, start: number): TagRead {
  let index = start + 1;
  let closing = false;
  if (source[index] === "/") { closing = true; index += 1; }
  if (!/[a-z]/i.test(source[index] ?? "")) return { kind: "text" };
  const nameStart = index;
  while (index < source.length && !/[\t\n\f\r />]/.test(source[index] ?? "")) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  if (index === source.length) return { kind: "unterminated" };
  if (!/[\s/>]/.test(source[index] ?? "")) return { kind: "text" };

  let quote = "";
  let lastNonWhitespace = "";
  for (; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return { kind: "tag", tag: { name, closing, end: index + 1, selfClosing: lastNonWhitespace === "/" } };
    }
    if (!/\s/.test(char)) lastNonWhitespace = char;
  }
  return { kind: "unterminated" };
}

function findRawTextClose(source: string, start: number, name: string): { kind: "found"; index: number } | { kind: "ambiguous" | "missing" } {
  const closeTag = new RegExp(`</${name}\\s*>`, "ig");
  closeTag.lastIndex = start;
  const match = closeTag.exec(source);
  if (!match) return { kind: "missing" };
  if (name === "script" && hasAmbiguousScriptEscaping(source, start, match.index)) return { kind: "ambiguous" };
  return { kind: "found", index: match.index };
}

function hasAmbiguousScriptEscaping(source: string, start: number, end: number): boolean {
  const body = source.slice(start, end);
  const commentStart = body.indexOf("<!--");
  return commentStart >= 0 && /<script(?=[\t\n\f\r />])/i.test(body.slice(commentStart + 4));
}

function findDeclarationEnd(source: string, start: number): number {
  let quote = "";
  let bracketDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === ">" && bracketDepth === 0) {
      return index + 1;
    }
  }
  return source.length;
}
