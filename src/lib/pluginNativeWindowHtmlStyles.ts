import { findActiveHtmlStyleTargets } from "./pluginHtmlScripts";
import { rewritePluginNativeAppRegionCss } from "./pluginNativeAppRegionCss";

const namedCharacterReferences: Record<string, string> = {
  amp: "&", apos: "'", colon: ":", gt: ">", lt: "<", quot: "\"",
  Tab: "\t", NewLine: "\n", percnt: "%", num: "#", lpar: "(", rpar: ")",
  sol: "/", semi: ";", equals: "=", ast: "*", plus: "+", comma: ",", period: ".",
};
let attributeDecodeTemplate: HTMLTemplateElement | undefined;

/** Rewrite active inline CSS in a native child document's in-memory HTML copy. */
export function rewritePluginNativeWindowHtmlStyles(html: string): string {
  const targets = findActiveHtmlStyleTargets(html);
  if (!targets.length) return html;

  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const target of targets) {
    const raw = html.slice(target.start, target.end);
    if (target.kind === "element") {
      const rewritten = rewritePluginNativeAppRegionCss(raw, "stylesheet");
      if (rewritten !== raw) edits.push({ ...target, value: rewritten });
      continue;
    }
    const decoded = decodeHtmlAttribute(raw);
    if (decoded == null) continue;
    const rewritten = rewritePluginNativeAppRegionCss(decoded, "declarations");
    if (rewritten !== decoded) {
      edits.push({ ...target, value: encodeHtmlAttribute(rewritten, target.quote) });
    }
  }

  if (!edits.length) return html;
  edits.sort((left, right) => left.start - right.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    chunks.push(html.slice(cursor, edit.start), edit.value);
    cursor = edit.end;
  }
  chunks.push(html.slice(cursor));
  return chunks.join("");
}

function decodeHtmlAttribute(raw: string): string | null {
  if (!raw.includes("&")) return raw;
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    if (!attributeDecodeTemplate || attributeDecodeTemplate.ownerDocument !== document) {
      attributeDecodeTemplate = document.createElement("template");
    }
    const safeValue = raw.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    attributeDecodeTemplate.innerHTML = `<i data-atools-style="${safeValue}"></i>`;
    return attributeDecodeTemplate.content.firstElementChild?.getAttribute("data-atools-style") ?? null;
  }
  return decodeHtmlAttributeWithoutDom(raw);
}

function decodeHtmlAttributeWithoutDom(raw: string): string | null {
  let unsupported = false;
  const value = raw.replace(/&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);?/gi, (entity) => {
    if (/^&#/i.test(entity)) {
      const body = entity.slice(2).replace(/;$/, "");
      const hex = /^x/i.test(body);
      const codePoint = Number.parseInt(hex ? body.slice(1) : body, hex ? 16 : 10);
      if (!Number.isFinite(codePoint)) { unsupported = true; return entity; }
      const normalized = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? 0xfffd
        : codePoint;
      return String.fromCodePoint(normalized);
    }
    const name = entity.slice(1).replace(/;$/, "");
    if (Object.prototype.hasOwnProperty.call(namedCharacterReferences, name)) return namedCharacterReferences[name];
    unsupported = true;
    return entity;
  });
  return unsupported ? null : value;
}

function encodeHtmlAttribute(value: string, quote: "\"" | "'" | null): string {
  let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (quote === "\"") return escaped.replace(/\"/g, "&quot;");
  if (quote === "'") return escaped.replace(/'/g, "&#39;");
  return escaped
    .replace(/\s/g, (char) => `&#${char.charCodeAt(0)};`)
    .replace(/>/g, "&gt;")
    .replace(/=/g, "&#61;")
    .replace(/`/g, "&#96;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
