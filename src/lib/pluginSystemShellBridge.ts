/** Host-side validation before passing a plugin-selected target to the OS. */
export function validateShellFilePath(value: unknown, method: "shellShowItemInFolder" | "shellTrashItem"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(method + " requires a file path");
  }
  if (value.length > 8192 || value.includes("\0") || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) {
    throw new Error(method + " requires an absolute file path without NUL, at most 8192 characters");
  }
  // Whitespace is part of a filename. Validation must never change the target.
  return value;
}

export function normalizeShellTrashPath(value: unknown): string {
  return validateShellFilePath(value, "shellTrashItem");
}

export function shellTrashAppleScript(path: unknown): string {
  return `tell application "Finder" to delete POSIX file ${appleScriptString(normalizeShellTrashPath(path))}`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
