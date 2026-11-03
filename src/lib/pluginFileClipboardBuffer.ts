/**
 * Decode a bounded subset of the file-list formats used by Electron and common
 * desktop clipboard providers. This deliberately does not accept arbitrary
 * binary formats or general-purpose plist/XML documents.
 */
export function decodePluginFileClipboardBuffer(format: string, input: unknown): string[] {
  const MAX_RAW_BYTES = 512 * 1024;
  const MAX_FILES = 20;
  const MAX_PATH_BYTES = 8 * 1024;
  const MAX_SERIALIZED_PATH_BYTES = 64 * 1024;
  const fail = (code: string, message: string): never => {
    const error = new Error(`ERR_ATOOLS_FILE_CLIPBOARD_${code}: ${message}`) as Error & { code: string };
    error.code = `ERR_ATOOLS_FILE_CLIPBOARD_${code}`;
    throw error;
  };

  if (typeof format !== "string") fail("UNSUPPORTED", "Clipboard format must be a string");
  if (format !== "NSFilenamesPboardType" && format !== "FileNameW" && format !== "text/uri-list") {
    fail("UNSUPPORTED", "Only the supported file-list clipboard formats are accepted");
  }
  if (!ArrayBuffer.isView(input) || Object.prototype.toString.call(input) !== "[object Uint8Array]") {
    fail("BYTES", "Clipboard data must be a Uint8Array or Buffer");
  }
  const view = input as Uint8Array;
  if (!Number.isSafeInteger(view.byteLength) || view.byteLength > MAX_RAW_BYTES) {
    fail("LIMIT", "Clipboard file data exceeds 512 KiB");
  }
  // Copy the visible view only. This preserves Buffer/subarray offsets and
  // prevents a caller from mutating the bytes during parsing.
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);

  const invalidXmlCharacter = (codePoint: number) => !(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff));
  const encoder = new TextEncoder();
  const validatePath = (path: string) => {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")
      || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(path))) {
      fail("PATH", "Clipboard entries must be absolute local paths without NUL");
    }
    for (let index = 0; index < path.length; index++) {
      const unit = path.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = path.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("PATH", "Clipboard path contains invalid Unicode");
        index++;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        fail("PATH", "Clipboard path contains invalid Unicode");
      }
    }
    if (encoder.encode(path).byteLength > MAX_PATH_BYTES) fail("LIMIT", "Clipboard path exceeds 8192 UTF-8 bytes");
  };
  const validatePaths = (paths: string[]): string[] => {
    if (paths.length < 1 || paths.length > MAX_FILES) fail("LIMIT", "Clipboard file count exceeds 20");
    for (const path of paths) validatePath(path);
    if (encoder.encode(JSON.stringify(paths)).byteLength > MAX_SERIALIZED_PATH_BYTES) {
      fail("LIMIT", "Serialized clipboard file paths exceed 64 KiB");
    }
    return paths;
  };
  const appendPath = (paths: string[], path: string) => {
    if (paths.length >= MAX_FILES) fail("LIMIT", "Clipboard file count exceeds 20");
    validatePath(path);
    paths.push(path);
    if (encoder.encode(JSON.stringify(paths)).byteLength > MAX_SERIALIZED_PATH_BYTES) {
      fail("LIMIT", "Serialized clipboard file paths exceed 64 KiB");
    }
  };
  const decodeUtf8 = (value: Uint8Array): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return fail("UTF8", "Clipboard data is not valid UTF-8");
    }
  };

  if (format === "NSFilenamesPboardType") {
    let text = decodeUtf8(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let offset = 0;
    const xmlWhitespace = (character: string) => character === " " || character === "\t"
      || character === "\r" || character === "\n";
    const skipWhitespace = (source: string, start: number) => {
      while (start < source.length && xmlWhitespace(source[start])) start++;
      return start;
    };
    const declaration = text.slice(offset).match(
      /^<\?xml[ \t\r\n]+version=(["'])1\.0\1(?:[ \t\r\n]+encoding=(["'])UTF-8\2)?(?:[ \t\r\n]+standalone=(["'])(?:yes|no)\3)?[ \t\r\n]*\?>/,
    );
    if (text.startsWith("<?xml")) {
      if (!declaration) return fail("XML", "Unsupported XML declaration");
      offset += declaration[0].length;
    }
    offset = skipWhitespace(text, offset);

    // Accept only the fixed Apple external identifier as literal syntax. It is
    // never resolved, and internal subsets or custom entities are not parsed.
    const appleDoctype = text.slice(offset).match(
      /^<!DOCTYPE[ \t\r\n]+plist[ \t\r\n]+PUBLIC[ \t\r\n]+(["'])-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN\1[ \t\r\n]+(["'])http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd\2[ \t\r\n]*>/,
    );
    if (text.slice(offset).startsWith("<!DOCTYPE")) {
      if (!appleDoctype) return fail("XML", "Unsupported plist doctype");
      offset += appleDoctype[0].length;
    }
    offset = skipWhitespace(text, offset);

    const plistOpen = text.slice(offset).match(
      /^<plist[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.0\1[ \t\r\n]*>/,
    );
    if (!plistOpen) return fail("XML", "Invalid file-list plist document");
    offset += plistOpen[0].length;
    offset = skipWhitespace(text, offset);
    const arrayOpen = text.slice(offset).match(/^<array[ \t\r\n]*>/);
    if (!arrayOpen) return fail("XML", "Expected a plist array");
    offset += arrayOpen[0].length;

    const paths: string[] = [];
    while (true) {
      offset = skipWhitespace(text, offset);
      const arrayClose = text.slice(offset).match(/^<\/array[ \t\r\n]*>/);
      if (arrayClose) {
        offset += arrayClose[0].length;
        break;
      }
      // Check before examining or decoding another array value so oversized
      // lists do not spend work parsing attacker-controlled content.
      if (paths.length >= MAX_FILES) fail("LIMIT", "Clipboard file count exceeds 20");
      const stringOpen = text.slice(offset).match(/^<string[ \t\r\n]*>/);
      if (!stringOpen) return fail("XML", "Unexpected plist array field");
      offset += stringOpen[0].length;
      const end = text.indexOf("</string", offset);
      if (end < 0) fail("XML", "Unterminated plist string");
      const stringClose = text.slice(end).match(/^<\/string[ \t\r\n]*>/);
      if (!stringClose) return fail("XML", "Malformed plist string closing tag");
      const encoded = text.slice(offset, end).replace(/\r\n?/g, "\n");
      let decoded = "";
      for (let index = 0; index < encoded.length;) {
        const character = encoded[index];
        if (character === "&") {
          const semicolon = encoded.indexOf(";", index + 1);
          if (semicolon < 0) fail("XML", "Invalid plist entity reference");
          const entity = encoded.slice(index, semicolon + 1);
          if (entity === "&amp;") decoded += "&";
          else if (entity === "&lt;") decoded += "<";
          else if (entity === "&gt;") decoded += ">";
          else if (entity === "&quot;") decoded += "\"";
          else if (entity === "&apos;") decoded += "'";
          else if (/^&#[0-9]+;$/.test(entity) || /^&#x[0-9a-fA-F]+;$/.test(entity)) {
            const hexadecimal = entity[2] === "x";
            const codePoint = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
            if (!Number.isSafeInteger(codePoint) || invalidXmlCharacter(codePoint)) {
              fail("XML", "Numeric plist reference is not an XML character");
            }
            decoded += String.fromCodePoint(codePoint);
          } else {
            fail("XML", "Unsupported plist entity reference");
          }
          index = semicolon + 1;
          continue;
        }
        if (character === "<" || encoded.startsWith("]]>", index)) fail("XML", "Invalid plist string markup");
        const codePoint = encoded.codePointAt(index) ?? fail("XML", "Invalid plist string character");
        if (invalidXmlCharacter(codePoint)) fail("XML", "Invalid plist string character");
        decoded += String.fromCodePoint(codePoint);
        index += codePoint > 0xffff ? 2 : 1;
      }
      appendPath(paths, decoded);
      offset = end + stringClose[0].length;
    }

    offset = skipWhitespace(text, offset);
    const plistClose = text.slice(offset).match(/^<\/plist[ \t\r\n]*>/);
    if (!plistClose) return fail("XML", "Missing plist document close");
    offset += plistClose[0].length;
    if (skipWhitespace(text, offset) !== text.length) fail("XML", "Unexpected content after plist document");
    return validatePaths(paths);
  }

  if (format === "FileNameW") {
    if (bytes.byteLength < 24 || bytes.byteLength % 2 !== 0) fail("DROPFILES", "Invalid DROPFILES size");
    const readU32LE = (offset: number) => bytes[offset] | bytes[offset + 1] << 8
      | bytes[offset + 2] << 16 | bytes[offset + 3] << 24;
    if (readU32LE(0) !== 20 || readU32LE(4) !== 0 || readU32LE(8) !== 0
      || readU32LE(12) !== 0 || readU32LE(16) !== 1) {
      fail("DROPFILES", "Unsupported DROPFILES header");
    }
    const units: number[] = [];
    for (let offset = 20; offset < bytes.byteLength; offset += 2) {
      const unit = bytes[offset] | bytes[offset + 1] << 8;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (offset + 3 >= bytes.byteLength) fail("DROPFILES", "Invalid UTF-16LE surrogate pair");
        const low = bytes[offset + 2] | bytes[offset + 3] << 8;
        if (low < 0xdc00 || low > 0xdfff) fail("DROPFILES", "Invalid UTF-16LE surrogate pair");
        units.push(unit, low);
        offset += 2;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        fail("DROPFILES", "Invalid UTF-16LE surrogate pair");
      } else {
        units.push(unit);
      }
    }
    const chunks: string[] = [];
    for (let index = 0; index < units.length; index += 8192) {
      chunks.push(String.fromCharCode(...units.slice(index, index + 8192)));
    }
    const text = chunks.join("");
    if (!text.endsWith("\0\0")) fail("DROPFILES", "File list lacks its double-NUL terminator");
    const body = text.slice(0, -2);
    const paths = body.split("\0");
    if (paths.length > MAX_FILES) fail("LIMIT", "Clipboard file count exceeds 20");
    if (paths.some(path => path.length === 0)) fail("DROPFILES", "Invalid empty DROPFILES entry");
    return validatePaths(paths);
  }

  const text = decodeUtf8(bytes);
  if (!text.endsWith("\r\n")) fail("URI_LIST", "URI list must end with CRLF");
  const entries = text.slice(0, -2).split("\r\n");
  if (entries.length > MAX_FILES) fail("LIMIT", "Clipboard file count exceeds 20");
  if (entries.some(entry => entry.length === 0)) fail("URI_LIST", "URI list contains an empty entry");
  const paths = entries.map(entry => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return fail("URI_LIST", "Invalid file URI");
    }
    if (url.protocol !== "file:" || url.host !== "" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.search !== "" || url.hash !== "" || url.href !== entry
      || !url.pathname.startsWith("/") || /%(?:2f|00)/i.test(url.pathname)) {
      fail("URI_LIST", "Only canonical local file URIs are supported");
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return fail("URI_LIST", "Invalid file URI escape");
    }
    // Node's Windows pathToFileURL emits /C:/...; convert that URL path back
    // to the drive path expected by the native file-list writer.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replaceAll("/", "\\");
    return path;
  });
  return validatePaths(paths);
}
