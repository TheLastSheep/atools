export function normalizeShellTrashPath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) {
    throw new Error("shellTrashItem requires a file path");
  }
  return path;
}

export function shellTrashAppleScript(path: unknown): string {
  return `tell application "Finder" to delete POSIX file ${appleScriptString(normalizeShellTrashPath(path))}`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
