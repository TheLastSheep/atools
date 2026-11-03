import type { FeatureAction, SearchResult } from "../../src/lib/types";

export const alphaPlugin: SearchResult = {
  code: "alpha-entry", plugin_id: "alpha-plugin", plugin_name: "Alpha 插件",
  label: "Alpha 插件", explain: "普通搜索往返 fixture", icon: null, score: 200, match_type: "exact",
};

export const betaPlugin: SearchResult = {
  code: "beta-entry", plugin_id: "beta-plugin", plugin_name: "Beta 插件",
  label: "Beta 插件", explain: "普通搜索往返 fixture", icon: null, score: 100, match_type: "exact",
};

export const gammaPlugin: SearchResult = {
  code: "gamma-entry", plugin_id: "gamma-plugin", plugin_name: "Gamma 插件",
  label: "Gamma 插件", explain: "竞争返回 fixture", icon: null, score: 300, match_type: "exact",
};

export const ordinaryPluginQuery = "fixture插件";

export function returnSearchResults(searchNumber: number, omitBeta = false): SearchResult[] {
  if (omitBeta && searchNumber > 1) return [alphaPlugin];
  return searchNumber === 1 ? [alphaPlugin, betaPlugin] : [
    { ...betaPlugin, score: 300 },
    { ...alphaPlugin, score: 200 },
  ];
}

export function pluginActivationAction(result: SearchResult): FeatureAction {
  return {
    plugin_id: result.plugin_id,
    plugin_name: result.plugin_name,
    feature_code: result.code,
    main_url: "index.html",
    plugin_path: "__atools_plugin_host_preview__",
    expand_height: 400,
    plugin_permissions: ["settings.redirect"],
    payload: { srcdoc: `<!doctype html><main>${result.plugin_name} synthetic fixture</main>` },
  };
}
