// @vitest-environment node

import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { decodePluginFileClipboardBuffer } from "../../src/lib/pluginFileClipboardBuffer";

const APPLE_PLIST = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
  + "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
  + "<plist version=\"1.0\"><array>"
  + "<string>/tmp/Paste &amp; data/二.txt</string><string>/tmp/quote &apos; &quot; &lt; &gt;.txt</string>"
  + "</array></plist>";
const EXPECTED_PATHS = [
  "/tmp/Paste & data/二.txt",
  "/tmp/quote ' \" < >.txt",
];

function windowsDropBuffer(paths: string[]): Uint8Array {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1, 16);
  const names = Buffer.from(`${paths.join("\0")}\0\0`, "utf16le");
  return Buffer.concat([header, names]);
}

describe("Harris file clipboard buffer decoder", () => {
  it("decodes only the original macOS, Windows and Linux file-list encodings", () => {
    expect(decodePluginFileClipboardBuffer("NSFilenamesPboardType", Buffer.from(APPLE_PLIST, "utf8")))
      .toEqual(EXPECTED_PATHS);
    expect(decodePluginFileClipboardBuffer("FileNameW", windowsDropBuffer(EXPECTED_PATHS)))
      .toEqual(EXPECTED_PATHS);
    const uriList = EXPECTED_PATHS.map(path => pathToFileURL(path).href).join("\r\n") + "\r\n";
    expect(decodePluginFileClipboardBuffer("text/uri-list", Buffer.from(uriList, "utf8")))
      .toEqual(EXPECTED_PATHS);
  });

  it("accepts a pretty-printed XML plist subset with optional headers and numeric references", () => {
    const prettyPrinted = `<?xml version='1.0' encoding='UTF-8'?>\n`
      + `<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' 'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>\n`
      + `<plist version = '1.0'>\n  <array>\n    <string>/tmp/pretty &amp; &#47; &#x1F9ED;.txt</string>\n  </array>\n</plist>\n`;
    expect(decodePluginFileClipboardBuffer("NSFilenamesPboardType", Buffer.from(prettyPrinted, "utf8")))
      .toEqual(["/tmp/pretty & / 🧭.txt"]);

    const noHeader = `<plist version="1.0">\r\n<array>\t<string>/tmp/optional &quot; header.txt</string>\r\n</array>\n</plist>`;
    expect(decodePluginFileClipboardBuffer("NSFilenamesPboardType", Buffer.from(noHeader, "utf8")))
      .toEqual([`/tmp/optional " header.txt`]);
  });

  it("uses only a Uint8Array slice's visible bytes and snapshots it before decoding", () => {
    const encoded = Buffer.from(APPLE_PLIST, "utf8");
    const backing = Buffer.concat([Buffer.from([0xff, 0x00]), encoded, Buffer.from([0x00, 0xff])]);
    const view = backing.subarray(2, backing.length - 2);
    expect(decodePluginFileClipboardBuffer("NSFilenamesPboardType", view)).toEqual(EXPECTED_PATHS);
  });

  it("rejects unsupported formats, non-byte views and over-budget raw buffers", () => {
    expect(() => decodePluginFileClipboardBuffer("application/x-private", Buffer.from("x")))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_UNSUPPORTED");
    expect(() => decodePluginFileClipboardBuffer("FileNameW", new DataView(new ArrayBuffer(20)) as never))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_BYTES");
    expect(() => decodePluginFileClipboardBuffer("NSFilenamesPboardType", new Uint8Array(512 * 1024 + 1)))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
  });

  it("rejects malformed plist, unsafe DTDs, invalid references and unexpected fields", () => {
    const invalid = [
      APPLE_PLIST.replace("<string>/tmp/Paste", "<key>metadata</key><string>/tmp/Paste"),
      APPLE_PLIST.replace("</array>", "<dict></dict></array>"),
      APPLE_PLIST.replace("<plist", "<!ENTITY x SYSTEM \"file:///etc/passwd\"><plist"),
      APPLE_PLIST.replace("<plist", "<!DOCTYPE plist [<!ENTITY x \"/tmp/evil\">]><plist"),
      APPLE_PLIST.replace("&amp;", "&custom;"),
      APPLE_PLIST.replace("&amp;", "&#0;"),
      APPLE_PLIST.replace("&amp;", "&#xD800;"),
      APPLE_PLIST.replace("&amp;", "&#x110000;"),
      APPLE_PLIST.replace("&amp;", "&#xZZ;"),
      APPLE_PLIST.replace("&amp;", "&#38"),
      APPLE_PLIST.replace("&amp;", "<nested>"),
      APPLE_PLIST.slice(0, -10),
    ];
    for (const value of invalid) {
      expect(() => decodePluginFileClipboardBuffer("NSFilenamesPboardType", Buffer.from(value, "utf8")))
        .toThrow("ERR_ATOOLS_FILE_CLIPBOARD");
    }
    expect(() => decodePluginFileClipboardBuffer("NSFilenamesPboardType", new Uint8Array([0xff])))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_UTF8");
  });

  it("requires a canonical local URI list with valid UTF-8, escapes and line endings", () => {
    const invalid = [
      "https://example.test/file.txt\r\n",
      "file://example.test/tmp/file.txt\r\n",
      "file:///tmp/file%2Fname.txt\r\n",
      "file:///tmp/%00name.txt\r\n",
      "file:///tmp/file.txt\n",
      "file:///tmp/bad%ZZ.txt\r\n",
      "file:///tmp/file.txt?query=1\r\n",
      "file:///tmp/file.txt#fragment\r\n",
    ];
    for (const value of invalid) {
      expect(() => decodePluginFileClipboardBuffer("text/uri-list", Buffer.from(value, "utf8")))
        .toThrow("ERR_ATOOLS_FILE_CLIPBOARD");
    }
    expect(() => decodePluginFileClipboardBuffer("text/uri-list", new Uint8Array([0xff])))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_UTF8");
  });

  it("requires a complete canonical DROPFILES header and terminated UTF-16LE path list", () => {
    const valid = windowsDropBuffer(["/tmp/a.txt"]);
    const invalid: Uint8Array[] = [];
    const wrongOffset = Uint8Array.from(valid);
    new DataView(wrongOffset.buffer).setUint32(0, 19, true);
    invalid.push(wrongOffset);
    const wrongFlags = Uint8Array.from(valid);
    new DataView(wrongFlags.buffer).setUint32(16, 0, true);
    invalid.push(wrongFlags);
    invalid.push(valid.slice(0, valid.length - 2));
    invalid.push(Buffer.concat([Buffer.from(valid), Buffer.from([0])]));
    const badSurrogate = windowsDropBuffer(["/tmp/a.txt"]);
    badSurrogate[badSurrogate.length - 6] = 0x00;
    badSurrogate[badSurrogate.length - 5] = 0xd8;
    invalid.push(badSurrogate);
    for (const [index, bytes] of invalid.entries()) {
      expect(() => decodePluginFileClipboardBuffer("FileNameW", bytes), `invalid DROPFILES case ${index}`)
        .toThrow("ERR_ATOOLS_FILE_CLIPBOARD");
    }
  });

  it("enforces the native 20-path, 8192-byte path and 64-KiB path-list limits", () => {
    expect(() => decodePluginFileClipboardBuffer("FileNameW", windowsDropBuffer(
      Array.from({ length: 21 }, (_, index) => `/tmp/${index}.txt`),
    ))).toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
    expect(() => decodePluginFileClipboardBuffer("FileNameW", windowsDropBuffer([`/${"a".repeat(8192)}`])))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
    const tooManyBytes = Array.from({ length: 9 }, (_, index) => `/tmp/${index}/${"a".repeat(8_190)}`);
    const uris = tooManyBytes.map(path => pathToFileURL(path).href).join("\r\n") + "\r\n";
    expect(() => decodePluginFileClipboardBuffer("text/uri-list", Buffer.from(uris, "utf8")))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
  });

  it("applies the JSON path-list budget after Windows escaping and rejects 21 URIs before parsing them", () => {
    const escapedWindowsPath = `C:\\${"a\\".repeat(4_094)}a`;
    expect(Buffer.byteLength(escapedWindowsPath, "utf8")).toBe(8_192);
    const paths = Array.from({ length: 7 }, () => escapedWindowsPath);
    expect(paths.reduce((sum, path) => sum + Buffer.byteLength(path, "utf8"), 0)).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(paths), "utf8")).toBeGreaterThan(64 * 1024);
    expect(() => decodePluginFileClipboardBuffer("FileNameW", windowsDropBuffer(paths)))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");

    const uriList = Array.from({ length: 21 }, (_, index) => `file:///tmp/${index}.txt`).join("\r\n") + "\r\n";
    const NativeURL = globalThis.URL;
    let constructions = 0;
    class CountingURL extends NativeURL {
      constructor(input: string | URL, base?: string | URL) {
        constructions++;
        super(input, base);
      }
    }
    vi.stubGlobal("URL", CountingURL);
    try {
      expect(() => decodePluginFileClipboardBuffer("text/uri-list", Buffer.from(uriList, "utf8")))
        .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
      expect(constructions).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a 21st plist entry before decoding that entry", () => {
    const twentyValidStrings = Array.from({ length: 20 }, (_, index) => `<string>/tmp/${index}.txt</string>`).join("");
    const overLimitWithMalformedTail = `<?xml version="1.0"?><plist version="1.0"><array>${twentyValidStrings}<dict>`
      + `</array></plist>`;
    expect(() => decodePluginFileClipboardBuffer("NSFilenamesPboardType", Buffer.from(overLimitWithMalformedTail, "utf8")))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
  });
});
