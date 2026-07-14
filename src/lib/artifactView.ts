import type { TaskRunArtifact } from "./types";

export type ArtifactRenderKind =
  | "image"
  | "table"
  | "markdown"
  | "diff"
  | "json"
  | "file"
  | "url"
  | "text";

export type ArtifactTable = {
  columns: string[];
  rows: Array<Record<string, string>>;
  truncated: boolean;
};

export type MarkdownBlock = {
  kind: "heading" | "paragraph" | "list_item" | "code";
  text: string;
  level?: number;
  ordered?: boolean;
};

export function artifactRenderKind(artifact: TaskRunArtifact): ArtifactRenderKind {
  switch (artifact.kind.toLowerCase()) {
    case "image":
    case "screenshot":
      return "image";
    case "table":
    case "csv":
      return "table";
    case "markdown":
    case "rich_text":
      return "markdown";
    case "diff":
      return "diff";
    case "json":
      return "json";
    case "file":
    case "directory":
    case "report":
    case "log":
      return "file";
    case "url":
      return "url";
    default:
      return "text";
  }
}

export function artifactPayload(artifact: TaskRunArtifact, runOutput: unknown): unknown {
  if (isRecord(artifact.metadata)) {
    const outputField = artifact.metadata.outputField;
    if (typeof outputField === "string" && isRecord(runOutput)) {
      return runOutput[outputField] ?? null;
    }
    for (const key of ["content", "data", "value", "rows"]) {
      if (Object.prototype.hasOwnProperty.call(artifact.metadata, key)) {
        return artifact.metadata[key];
      }
    }
  }
  if (artifact.uri?.startsWith("atools://task-runs/") || artifact.kind === "json") {
    return runOutput;
  }
  return null;
}

export function artifactLocation(artifact: TaskRunArtifact): string | null {
  const path = artifact.path?.trim();
  if (path) return path;
  const uri = artifact.uri?.trim();
  if (!uri || uri.startsWith("atools://")) return null;
  return uri;
}

export function artifactPreviewSource(
  artifact: TaskRunArtifact,
  tauriAvailable: boolean,
  convertFileSrc: (path: string) => string,
): string | null {
  const path = artifact.path?.trim();
  if (path) return tauriAvailable ? convertFileSrc(path) : null;
  const uri = artifact.uri?.trim();
  if (!uri) return null;
  if (/^(data:image\/|blob:|asset:)/i.test(uri)) return uri;
  return null;
}

export function artifactTable(payload: unknown, maxRows = 100, maxColumns = 12): ArtifactTable | null {
  const source = isRecord(payload) && Array.isArray(payload.items) ? payload.items : payload;
  if (typeof source === "string") {
    return csvTable(source, maxRows, maxColumns);
  }
  if (!Array.isArray(source) || source.length === 0) return null;

  const objects = source.filter(isRecord);
  if (objects.length !== source.length) return null;
  const columns = Array.from(new Set(objects.flatMap((row) => Object.keys(row)))).slice(0, maxColumns);
  if (columns.length === 0) return null;
  return {
    columns,
    rows: objects.slice(0, maxRows).map((row) => Object.fromEntries(
      columns.map((column) => [column, displayCell(row[column])]),
    )),
    truncated: source.length > maxRows || objects.some((row) => Object.keys(row).length > maxColumns),
  };
}

export function artifactMarkdownBlocks(payload: unknown): MarkdownBlock[] {
  const source = typeof payload === "string" ? payload : displayCell(payload);
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      blocks.push({
        kind: "list_item",
        text: (unordered ?? ordered)?.[1] ?? "",
        ordered: Boolean(ordered),
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
}

export function artifactDiffLines(payload: unknown): Array<{ text: string; tone: "add" | "remove" | "context" | "header" }> {
  const source = typeof payload === "string" ? payload : displayCell(payload);
  return source.split(/\r?\n/).map((text) => ({
    text,
    tone: text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")
      ? "header"
      : text.startsWith("+")
        ? "add"
        : text.startsWith("-")
          ? "remove"
          : "context",
  }));
}

export function artifactJson(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload ?? "");
  }
}

function csvTable(source: string, maxRows: number, maxColumns: number): ArtifactTable | null {
  const rows = source.split(/\r?\n/).filter((line) => line.trim()).map(parseCsvRow);
  if (rows.length < 2) return null;
  const columns = rows[0].slice(0, maxColumns).map((column, index) => column || `column_${index + 1}`);
  return {
    columns,
    rows: rows.slice(1, maxRows + 1).map((row) => Object.fromEntries(
      columns.map((column, index) => [column, row[index] ?? ""]),
    )),
    truncated: rows.length - 1 > maxRows || rows[0].length > maxColumns,
  };
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function displayCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
