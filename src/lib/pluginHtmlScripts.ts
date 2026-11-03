export type HtmlScriptSpan = {
  start: number;
  openEnd: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  attributes: string;
};

export type HtmlStyleTarget =
  | { kind: "attribute"; start: number; end: number; quote: "\"" | "'" | null }
  | { kind: "element"; start: number; end: number };

const rawTextTags = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "iframe", "noembed", "noframes"]);
type TagRead =
  | { kind: "tag"; tag: { start: number; openEnd: number; name: string; closing: boolean; attributes: string; attributesStart: number } }
  | { kind: "text" }
  | { kind: "unterminated" };

/** Locate active script elements without parsing, loading, or reserializing the document. */
export function findActiveHtmlScriptSpans(source: string): HtmlScriptSpan[] {
  const scripts: HtmlScriptSpan[] = [];
  scanActiveHtml(source, {
    onRawText: (tag, contentStart, contentEnd, end) => {
      if (tag.name !== "script") return;
      scripts.push({ start: tag.start, openEnd: tag.openEnd, contentStart, contentEnd, end, attributes: tag.attributes });
    },
  });
  return scripts;
}

/** Locate style attributes and active style-element content without touching raw HTML text. */
export function findActiveHtmlStyleTargets(source: string): HtmlStyleTarget[] {
  const targets: HtmlStyleTarget[] = [];
  scanActiveHtml(source, {
    onElement: (tag) => {
      if (tag.name === "script" || tag.name === "style") return;
      const attribute = findStyleAttribute(source, tag.attributesStart, tag.openEnd - 1);
      if (attribute) targets.push(attribute);
    },
    onRawText: (tag, contentStart, contentEnd) => {
      if (tag.name === "style") targets.push({ kind: "element", start: contentStart, end: contentEnd });
    },
  });
  return targets;
}

type HtmlTag = {
  start: number;
  openEnd: number;
  name: string;
  closing: boolean;
  attributes: string;
  attributesStart: number;
};

function scanActiveHtml(source: string, visitor: {
  onElement?: (tag: HtmlTag) => void;
  onRawText?: (tag: HtmlTag, contentStart: number, contentEnd: number, end: number) => void;
}): void {
  let index = 0, templateDepth = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[index] !== "<") { index++; continue; }
    const parsed = readTag(source, index);
    if (parsed.kind === "text") { index++; continue; }
    if (parsed.kind === "unterminated") return;
    const tag = parsed.tag;
    index = tag.openEnd;
    if (tag.closing) {
      if (tag.name === "template" && templateDepth > 0) templateDepth--;
      continue;
    }
    if (tag.name === "template") { templateDepth++; continue; }
    if (tag.name === "plaintext") return;
    if (templateDepth === 0) visitor.onElement?.(tag);
    if (rawTextTags.has(tag.name)) {
      const close = findRawTextClose(source, tag.openEnd, tag.name);
      const contentEnd = close?.start ?? source.length;
      const end = close?.end ?? source.length;
      if (templateDepth === 0) visitor.onRawText?.(tag, tag.openEnd, contentEnd, end);
      index = end;
      continue;
    }
  }
}

function readTag(source: string, start: number): TagRead {
  let index = start + 1, closing = false;
  if (source[index] === "/") { closing = true; index++; }
  if (!/[a-z]/i.test(source[index] ?? "")) return { kind: "text" };
  const nameStart = index;
  while (index < source.length && !/[\t\n\f\r />]/.test(source[index] ?? "")) index++;
  const name = source.slice(nameStart, index).toLowerCase();
  if (index === source.length) return { kind: "unterminated" };
  if (!/[\s/>]/.test(source[index] ?? "")) return { kind: "text" };
  const attrStart = index;
  let quote = "";
  while (index < source.length) {
    const char = source[index++];
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return { kind: "tag", tag: { start, openEnd: index, name, closing,
      attributes: source.slice(attrStart, index - 1), attributesStart: attrStart } };
  }
  return { kind: "unterminated" };
}

function findStyleAttribute(source: string, start: number, end: number): HtmlStyleTarget | undefined {
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && /[\t\n\f\r />]/.test(source[cursor] ?? "")) cursor++;
    if (cursor >= end) break;
    const nameStart = cursor;
    while (cursor < end && !/[\t\n\f\r =/>]/.test(source[cursor] ?? "")) cursor++;
    if (cursor === nameStart) { cursor++; continue; }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < end && /[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] !== "=") continue;
    cursor++;
    while (cursor < end && /[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor++;
    const quote = source[cursor] === "\"" || source[cursor] === "'" ? source[cursor++] as "\"" | "'" : null;
    const valueStart = cursor;
    if (quote) {
      while (cursor < end && source[cursor] !== quote) cursor++;
      const valueEnd = cursor;
      if (cursor < end) cursor++;
      if (name === "style") return { kind: "attribute", start: valueStart, end: valueEnd, quote };
    } else {
      while (cursor < end && !/[\t\n\f\r >]/.test(source[cursor] ?? "")) cursor++;
      if (name === "style") return { kind: "attribute", start: valueStart, end: cursor, quote: null };
    }
  }
}

function findRawTextClose(source: string, start: number, name: string): { start: number; end: number } | undefined {
  const closeTag = new RegExp(`</${name}\\s*>`, "ig");
  closeTag.lastIndex = start;
  const match = closeTag.exec(source);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}
