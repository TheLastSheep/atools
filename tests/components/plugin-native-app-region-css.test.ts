import { describe, expect, it } from "vitest";
import {
  createPluginNativeAppRegionCss,
  rewritePluginNativeAppRegionCss,
} from "../../src/lib/pluginNativeAppRegionCss";

describe("native app-region CSS rewriting", () => {
  it("rewrites declarations inside nested rules and keeps order and importance", () => {
    const input = "@layer shell { @media (min-width: 1px) { #drag { color: red; -webkit-app-region: drag !important; app-region: no-drag; } } }";
    expect(rewritePluginNativeAppRegionCss(input)).toBe(
      "@layer shell { @media (min-width: 1px) { #drag { color: red; --atools-native-app-region: drag !important; --atools-native-app-region: no-drag; } } }",
    );
  });

  it("does not rewrite comments, strings, URLs, selectors, or custom property values", () => {
    const input = "/* -webkit-app-region: drag */ [data-label=\"-webkit-app-region: drag\"] { content: \"-webkit-app-region: drag\"; background: url(\"data:text/plain,-webkit-app-region: drag\"); --note: -webkit-app-region: drag; }";
    expect(rewritePluginNativeAppRegionCss(input)).toBe(input);
  });

  it("recognizes escaped CSS property identifiers and is idempotent", () => {
    const escaped = ".drag { -\\77 ebkit-app-region: drag; }";
    const rewritten = ".drag { --atools-native-app-region: drag; }";
    expect(rewritePluginNativeAppRegionCss(escaped)).toBe(rewritten);
    expect(rewritePluginNativeAppRegionCss(rewritten)).toBe(rewritten);
  });

  it("supports declaration-list mode, var values, and CSS-wide keywords", () => {
    const input = "-webkit-app-region: var(--region, no-drag) !important; app-region: inherit;";
    expect(rewritePluginNativeAppRegionCss(input, "declarations")).toBe(
      "--atools-native-app-region: var(--region, no-drag) !important; --atools-native-app-region: inherit;",
    );
  });

  it("leaves invalid values and unrelated identifiers unchanged", () => {
    const input = "-webkit-app-region: banana; -webkit-app-region-extra: drag;";
    expect(rewritePluginNativeAppRegionCss(input)).toBe(input);
  });

  it("preserves a later none value in the cascade and leaves ordinary declarations intact", () => {
    const input = "#item { -webkit-app-region: drag; color: red; app-region: none }";
    expect(rewritePluginNativeAppRegionCss(input)).toBe(
      "#item { --atools-native-app-region: drag; color: red; --atools-native-app-region: none }",
    );
  });

  it("exposes a standalone serializable converter factory", () => {
    const factorySource = createPluginNativeAppRegionCss.toString();
    const factory = new Function(`return (${factorySource})`)() as typeof createPluginNativeAppRegionCss;
    expect(factory()(".x { app-region: drag; }")).toBe(
      ".x { --atools-native-app-region: drag; }",
    );
  });

  it("fails closed on excessive nesting without overflowing or damaging surrounding CSS", () => {
    const nested = ".deep {".repeat(10_000) + "color: red;" + "}".repeat(10_000);
    const input = `.root { -webkit-app-region: drag; ${nested} }`;
    const rewritten = rewritePluginNativeAppRegionCss(input);

    expect(rewritten).toBe(`.root { --atools-native-app-region: drag; ${nested} }`);
  });
});
