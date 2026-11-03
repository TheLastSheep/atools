export type InventorySearchFeature = {
  code: string;
  label?: string | null;
  explain?: string;
};

export type PluginInventoryFeatureTarget = {
  code: string;
  label: string;
};

export type PluginInventoryFeatureSummary = {
  featurePreview: string;
  searchText: string;
  target: PluginInventoryFeatureTarget | null;
};

export type PluginInventoryOpenIntent = { code?: string };

/** Builds the list's existing feature text and derives a unique feature target in one pass. */
export function summarizePluginInventoryFeatures(
  pluginName: string,
  features: InventorySearchFeature[],
  query: string,
  metadataMatches: boolean,
): PluginInventoryFeatureSummary {
  const normalizedQuery = query.trim().toLowerCase();
  const previewItems: string[] = [];
  const searchParts: string[] = [];
  const codeCounts = new Map<string, number>();
  let matchCount = 0;
  let matchedFeature: InventorySearchFeature | null = null;

  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    if (index < 3) previewItems.push(featurePreviewLabel(feature));
    searchParts.push([feature.code, feature.label ?? "", feature.explain].join(" "));
    codeCounts.set(feature.code, Math.min(2, (codeCounts.get(feature.code) ?? 0) + 1));

    if (normalizedQuery && !metadataMatches && featureMatchesQuery(feature, normalizedQuery)) {
      matchCount = Math.min(2, matchCount + 1);
      if (matchCount === 1) matchedFeature = feature;
    }
  }

  const rawCode = matchedFeature?.code;
  const target = matchCount === 1 && matchedFeature && rawCode && rawCode.trim().length > 0 && codeCounts.get(rawCode) === 1
    ? { code: rawCode, label: featureTargetLabel(matchedFeature) }
    : null;
  return {
    featurePreview: previewItems.join(" / ") || "暂无 feature",
    searchText: `${pluginName} ${searchParts.join(" ")}`,
    target,
  };
}

/** Compares the rendered target with a fresh derived target before dispatching an open request. */
export function samePluginInventoryFeatureTarget(
  rendered: PluginInventoryFeatureTarget | null,
  current: PluginInventoryFeatureTarget | null,
): boolean {
  return rendered === null
    ? current === null
    : current !== null && rendered.code === current.code && rendered.label === current.label;
}

/** Returns null for stale/disabled clicks and an empty intent for the generic default path. */
export function resolvePluginInventoryOpenIntent(
  rendered: PluginInventoryFeatureTarget | null,
  current: PluginInventoryFeatureTarget | null,
  enabled: boolean,
): PluginInventoryOpenIntent | null {
  if (!enabled || !samePluginInventoryFeatureTarget(rendered, current)) return null;
  return current ? { code: current.code } : {};
}

function featureMatchesQuery(feature: InventorySearchFeature, query: string): boolean {
  return [feature.code, feature.label ?? "", feature.explain ?? ""]
    .some((value) => value.toLowerCase().includes(query));
}

function featurePreviewLabel(feature: InventorySearchFeature): string {
  if (feature.label === "") return feature.code;
  return feature.label || feature.explain || feature.code;
}

function featureTargetLabel(feature: InventorySearchFeature): string {
  return feature.label?.trim() || feature.explain?.trim() || feature.code;
}
