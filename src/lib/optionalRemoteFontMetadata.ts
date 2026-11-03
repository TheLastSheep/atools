/** Recognizes only inert Google Fonts link metadata that can safely fall back to local system fonts. */
const MAX_LINK_TAG_CHARS = 4096;
const MAX_FONT_URL_CHARS = 2048;
const MAX_FONT_QUERY_CHARS = 1536;
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const FONT_DISPLAY_VALUES = new Set(["auto", "block", "fallback", "optional", "swap"]);

type Attributes = Map<string, string | null>;

/**
 * True only for simple optional font stylesheet/preconnect links. Ambiguous tags
 * are left for the normal resource pipeline and CSP diagnostics to handle.
 */
export function isOptionalRemoteFontMetadataLink(tag: string): boolean {
  const attributes = parseSimpleLinkTag(tag);
  if (!attributes) return false;
  const rel = attributes.get("rel");
  const href = attributes.get("href");
  if (typeof rel !== "string" || typeof href !== "string" || !isAnonymousCrossOrigin(attributes)) return false;

  const relations = rel.trim().toLowerCase().split(/\s+/);
  if (relations.length !== 1) return false;
  const relation = relations[0];
  if (relation === "stylesheet") {
    if (!onlyAttributes(attributes, ["rel", "href", "crossorigin"])) return false;
    return isGoogleFontStylesheetUrl(href);
  }
  if (relation === "preconnect" || relation === "dns-prefetch") {
    if (!onlyAttributes(attributes, ["rel", "href", "crossorigin"])) return false;
    return isGoogleFontPreconnectUrl(href);
  }
  return false;
}

function parseSimpleLinkTag(tag: string): Attributes | null {
  if (tag.length > MAX_LINK_TAG_CHARS || !/^<link(?=[\s/>])/i.test(tag) || !tag.endsWith(">")) return null;
  const attributes: Attributes = new Map();
  let index = 5;
  const end = tag.length - 1;

  while (index < end) {
    while (index < end && /\s/.test(tag[index])) index += 1;
    if (index === end || tag[index] === "/") {
      index += tag[index] === "/" ? 1 : 0;
      while (index < end && /\s/.test(tag[index])) index += 1;
      return index === end ? attributes : null;
    }

    const nameStart = index;
    while (index < end && !/[\s=/>]/.test(tag[index])) index += 1;
    if (index === nameStart) return null;
    const name = tag.slice(nameStart, index).toLowerCase();
    if (!/^[a-z][a-z0-9:_-]*$/.test(name) || attributes.has(name)) return null;
    while (index < end && /\s/.test(tag[index])) index += 1;

    let value: string | null = null;
    if (tag[index] === "=") {
      index += 1;
      while (index < end && /\s/.test(tag[index])) index += 1;
      if (index >= end) return null;
      const quote = tag[index] === "'" || tag[index] === '"' ? tag[index++] : "";
      const valueStart = index;
      if (quote) {
        while (index < end && tag[index] !== quote) index += 1;
        if (index >= end) return null;
        value = tag.slice(valueStart, index++);
      } else {
        while (index < end && !/[\s>]/.test(tag[index])) {
          if (/["'`<=]/.test(tag[index])) return null;
          index += 1;
        }
        if (index === valueStart) return null;
        value = tag.slice(valueStart, index);
      }
    }
    attributes.set(name, value);
  }
  return attributes;
}

function onlyAttributes(attributes: Attributes, allowed: readonly string[]): boolean {
  return [...attributes.keys()].every(name => allowed.includes(name));
}

function isAnonymousCrossOrigin(attributes: Attributes): boolean {
  if (!attributes.has("crossorigin")) return true;
  const value = attributes.get("crossorigin");
  if (value === undefined) return false;
  return value === null || value === "" || value.toLowerCase() === "anonymous";
}

function parseHttpsUrl(value: string): URL | null {
  if (value.length > MAX_FONT_URL_CHARS || value !== value.trim()
    || /[\u0000-\u0020\u007f]/.test(value) || value.includes("#")
    || !value.startsWith("https://")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function isGoogleFontPreconnectUrl(value: string): boolean {
  const url = parseHttpsUrl(value);
  return !!url && FONT_HOSTS.has(url.hostname)
    && (url.pathname === "/" || url.pathname === "") && !url.search;
}

function isGoogleFontStylesheetUrl(value: string): boolean {
  const url = parseHttpsUrl(value);
  if (!url || url.hostname !== "fonts.googleapis.com"
    || !["/css", "/css2"].includes(url.pathname)
    || !url.search || url.search.length > MAX_FONT_QUERY_CHARS) return false;

  let familyCount = 0;
  let displayCount = 0;
  let valid = true;
  url.searchParams.forEach((parameter, key) => {
    if (key === "family") {
      if (!parameter || parameter.length > 256) { valid = false; return; }
      familyCount += 1;
    } else if (key === "display") {
      if (displayCount > 0 || !FONT_DISPLAY_VALUES.has(parameter)) { valid = false; return; }
      displayCount += 1;
    } else {
      valid = false;
    }
  });
  return valid && familyCount > 0;
}
