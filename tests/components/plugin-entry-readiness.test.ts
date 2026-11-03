import { describe, expect, it } from "vitest";
import { assertPluginEntryReady } from "../../src/lib/pluginEntryReadiness";

describe("plugin release entry readiness", () => {
  it.each(["/src/main.ts", "./src/main.tsx?v=1", "/main.tsx", "src/index.js", "./App.vue"])("explains a source-only %s before preload or iframe execution", src => {
    expect(() => assertPluginEntryReady(`<html><script type="module" src="${src}"></script></html>`)).toThrow("尚未构建");
  });
  it("allows released classic/module assets and ignores source-like business strings or comments", () => {
    expect(() => assertPluginEntryReady(`<script type="module" src="./assets/index-abc.js"></script>
      <script src="main.js"></script><script>const example='/src/main.tsx';</script>
      <!-- <script src="/src/main.ts"></script> -->`)).not.toThrow();
  });
  it("does not classify a remote server's URL as unbuilt local source", () => {
    expect(() => assertPluginEntryReady('<script src="https://example.invalid/compiled.ts"></script>')).not.toThrow();
  });
});
