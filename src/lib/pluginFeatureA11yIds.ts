let nextPluginFeatureListId = 0;

/** Allocate a document-unique listbox id for one mounted plugin panel instance. */
export function createPluginA11yId(purpose: "feature-list" | "navigation-key-hint" | "runtime-info"): string {
  nextPluginFeatureListId += 1;
  return `atools-plugin-${purpose}-${nextPluginFeatureListId}`;
}

export function createPluginFeatureListId(): string {
  return createPluginA11yId("feature-list");
}

/** Derive an option id only from a validated non-negative row index. */
export function pluginFeatureOptionId(listboxId: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("invalid plugin feature option index");
  return `${listboxId}-option-${index}`;
}
