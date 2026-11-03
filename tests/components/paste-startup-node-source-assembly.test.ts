// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assemblePasteNodeRuntimeSource,
  pasteNodeRuntimeSourceFiles,
} from "../fixtures/paste-startup/node-source-assembly.mjs";

const repositoryRoot = resolve(process.cwd());
const runtimeRoot = join(repositoryRoot, "crates/atools-plugin/src/legacy_node");

describe("Paste isolated Product Node source assembly", () => {
  it("tracks the exact production bootstrap dependency order after both fixture policies", async () => {
    const rustModule = await readFile(join(runtimeRoot, "mod.rs"), "utf8");
    const productionFiles = [...rustModule.matchAll(/include_str!\("([^"]+\.cjs)"\)/gu)]
      .map(match => `crates/atools-plugin/src/legacy_node/${match[1]}`);
    expect(pasteNodeRuntimeSourceFiles).toEqual(productionFiles);

    const policySource = "/* offline node policy */\n/* paste-only controlled monitor policy */";
    const source = await assemblePasteNodeRuntimeSource(repositoryRoot, policySource);
    expect(source.startsWith(`${policySource}\n`)).toBe(true);
    const markers = [
      "const MAX_BYTES = 1024 * 1024;",
      "function readBoundedPngPath(params)",
      "const MAX_NATIVE_IMAGE_SOURCE_BYTES = 4 * 1024 * 1024;",
      "function createManagedChildTransport(",
      "function createManagedChildStreams(",
      "function installManagedNodeChildren()",
      "const Module = require('node:module');\nconst readline = require('node:readline');",
      "const installation = installManagedNodeChildren();",
    ];
    const positions = markers.map(marker => source.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("keeps the production installer inert when Paste has no managed socket environment", async () => {
    const managedChildren = await readFile(join(runtimeRoot, "managed_children.cjs"), "utf8");
    const environment = { ATOOLS_PLUGIN_ID: "pasteboard-pro" };
    const require = vi.fn(() => { throw new Error("installer must not open a socket or load a helper without managed config"); });
    const context: Record<string, any> = { process: { env: environment }, require };
    runInNewContext(`${managedChildren}\nglobalThis.__install = installManagedNodeChildren;`, context);

    expect(context.__install()).toBeUndefined();
    expect(environment).toEqual({ ATOOLS_PLUGIN_ID: "pasteboard-pro" });
    expect(require).not.toHaveBeenCalled();
  });
});
