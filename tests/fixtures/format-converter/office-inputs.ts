import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ZipEntry = { name: string; bytes: Buffer };

export const EXPECTED_DOCX_PARAGRAPHS = [
  "Harris Office fixture",
  "离线转换测试 & <example>",
] as const;

export const EXPECTED_XLSX_MATRIX = [
  ["Name", "Value", "Note"],
  ["Ada", "3", 'comma, quote "'],
  ["Bo", "4", "离线测试"],
] as const;

export type FormatConverterOfficeInputs = {
  inputDir: string;
  docxPath: string;
  xlsxPath: string;
  brokenDocxPath: string;
  expectedDocxParagraphs: typeof EXPECTED_DOCX_PARAGRAPHS;
  expectedDocxText: string;
  expectedXlsxMatrix: string[][];
  sha256: {
    docx: string;
    xlsx: string;
    brokenDocx: string;
    retryDocx: string;
  };
  retry: { path: string; bytes: Buffer; sha256: string };
};

/** Writes small deterministic OOXML packages; retry.bytes replaces retry.path in place. */
export async function writeOfficeInputs(inputDirectory: string): Promise<FormatConverterOfficeInputs> {
  const inputDir = resolve(inputDirectory);
  const docxPath = resolve(inputDir, "harris-office.docx");
  const xlsxPath = resolve(inputDir, "harris-office.xlsx");
  const brokenDocxPath = resolve(inputDir, "broken-retry.docx");
  const docxBytes = createDocx(EXPECTED_DOCX_PARAGRAPHS);
  const xlsxBytes = createXlsx(EXPECTED_XLSX_MATRIX);
  const brokenDocxBytes = createDocx(["Harris Office fixture"], true);
  const docxSha256 = sha256(docxBytes);
  const xlsxSha256 = sha256(xlsxBytes);
  const brokenDocxSha256 = sha256(brokenDocxBytes);

  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(docxPath, docxBytes, { mode: 0o600 }),
    writeFile(xlsxPath, xlsxBytes, { mode: 0o600 }),
    writeFile(brokenDocxPath, brokenDocxBytes, { mode: 0o600 }),
  ]);

  return {
    inputDir,
    docxPath,
    xlsxPath,
    brokenDocxPath,
    expectedDocxParagraphs: EXPECTED_DOCX_PARAGRAPHS,
    expectedDocxText: EXPECTED_DOCX_PARAGRAPHS.join("\n"),
    expectedXlsxMatrix: EXPECTED_XLSX_MATRIX.map(row => [...row]),
    sha256: { docx: docxSha256, xlsx: xlsxSha256, brokenDocx: brokenDocxSha256, retryDocx: docxSha256 },
    retry: { path: brokenDocxPath, bytes: docxBytes, sha256: docxSha256 },
  };
}

function createDocx(paragraphs: readonly string[], malformedDocument = false) {
  const documentXml = malformedDocument
    ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`).join("") +
      `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
      `</w:body></w:document>`;
  return createStoredZip([
    { name: "[Content_Types].xml", bytes: utf8(docxContentTypes) },
    { name: "_rels/.rels", bytes: utf8(packageRelationships("word/document.xml")) },
    { name: "word/document.xml", bytes: utf8(documentXml) },
  ]);
}

function createXlsx(matrix: readonly (readonly string[])[]) {
  const rows = matrix.map((row, rowIndex) => `<row r="${rowIndex + 1}">` + row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }).join("") + "</row>").join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Input" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C${matrix.length}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${rows}</sheetData>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;
  return createStoredZip([
    { name: "[Content_Types].xml", bytes: utf8(xlsxContentTypes) },
    { name: "_rels/.rels", bytes: utf8(packageRelationships("xl/workbook.xml")) },
    { name: "xl/workbook.xml", bytes: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", bytes: utf8(workbookRelationships) },
    { name: "xl/worksheets/sheet1.xml", bytes: utf8(worksheet) },
  ]);
}

const docxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const xlsxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

function packageRelationships(target: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>` +
    `</Relationships>`;
}

function createStoredZip(entries: readonly ZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = utf8(entry.name);
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.bytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function columnName(number: number) {
  let value = number;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function xmlEscape(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function utf8(value: string) { return Buffer.from(value, "utf8"); }
function sha256(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
