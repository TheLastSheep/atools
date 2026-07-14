export function isEditableKeyboardTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  return tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || element.isContentEditable === true;
}

export function isMainSearchKeyboardTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: unknown; dataset?: unknown };
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  const dataset = element.dataset as { atoolsSearchInput?: unknown } | undefined;
  return tagName === "input" && dataset?.atoolsSearchInput === "true";
}
