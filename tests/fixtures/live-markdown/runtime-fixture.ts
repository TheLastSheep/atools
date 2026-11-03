import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createPluginRuntimePreload } from "../../../src/lib/pluginRuntimePreload";
import type { LiveMarkdownPackageCopy } from "./original-package";

export type OriginalPluginNodeEndpoints = { node: string; data: string; saveDialog: string; openDialog?: string };
export type OriginalPluginNodeSession = {
  endpoints: OriginalPluginNodeEndpoints;
  initialization: { nodeVersion: string; pid: number; protocolVersion: number };
  snapshot: () => Record<string, any>;
  stop: () => Promise<Record<string, any>>;
};
export type LiveMarkdownRuntime = ReturnType<typeof createPluginRuntimePreload>;

/** Prepares the untouched CJS graph with the production loader and its product Node bridge. */
export async function prepareLiveMarkdownRuntime(session: OriginalPluginNodeSession, packageCopy: LiveMarkdownPackageCopy) {
  const ownerId = randomUUID();
  let sessionId = "";
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}) => {
    commands.push({ command, args });
    if (command === "prepare_legacy_node") {
      assert.equal(args.pluginId, "live-markdown");
      assert.equal(args.instanceId, ownerId);
      sessionId = randomUUID();
      return { sessionId } as T;
    }
    if (command === "get_legacy_node_session") {
      assert.equal(args.sessionId, sessionId);
      return { endpoint: session.endpoints.node } as T;
    }
    if (command === "close_legacy_node") {
      assert.equal(args.pluginId, "live-markdown");
      assert.equal(args.instanceId, ownerId);
      return await session.stop() as T;
    }
    throw new Error(`Unexpected production Node runtime command: ${command}`);
  };
  const runtime = createPluginRuntimePreload(invoke, "live-markdown", () => true, async () => {}, ownerId);
  const reads: Array<{ path: string; bytes: number; sha256: string }> = [];
  const preloadScript = await runtime.prepare({
    pluginDir: packageCopy.pluginRoot,
    preloadPath: packageCopy.preloadPath,
    isCurrent: () => true,
    readTextFile: async path => {
      const actual = resolve(path);
      const relativePath = relative(packageCopy.pluginRoot, actual);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        throw new Error(`Production preload graph escaped immutable Live Markdown copy: ${actual}`);
      }
      const text = await readFile(actual, "utf8");
      const entry = packageCopy.builtHashes[relativePath];
      assert.ok(entry, `Production loader read a file outside the frozen original build: ${relativePath}`);
      const sha256 = createHash("sha256").update(text).digest("hex");
      assert.equal(sha256, entry.sha256, `Production loader read a changed original preload file: ${relativePath}`);
      reads.push({ path: relativePath, bytes: Buffer.byteLength(text), sha256 });
      return text;
    },
    onSafeStorageRequired: async () => { throw new Error("Unexpected safeStorage permission request in the original Live Markdown preload graph"); },
    onFileDragRequired: async () => { throw new Error("Unexpected file-drag permission request in the original Live Markdown preload graph"); },
  });
  assert.match(sessionId, /^[0-9a-f-]{36}$/u);
  assert.ok(reads.some(entry => entry.path === "preload/services.cjs"));
  const moduleCount = new Set(reads.map(entry => entry.path)).size;
  return { ownerId, sessionId, runtime, preloadScript, reads, moduleCount, commands };
}
