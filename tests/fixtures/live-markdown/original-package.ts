import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const pins = {
  "plugin.json": "2f613c85721ff6db369734895dab84c4b8a628f2be0d34353f90eb88deceddeb",
  "index.html": "f636f27e93b26474ba99d77f71078ddf00cb19eb65d1fc77c5ca4e648c9a871c",
  "logo.svg": "1d12b52b92bec382b2b41df8e22e60a1588faca944db2a09ecab05e38631f534",
  "assets/index-CTaIDxc4.js": "cd3057470f490cee8d16aa3bc96d65f401cd0c064c483815b62a073c783097e0",
  "assets/index-C2N-317C.css": "f67253f4e4c86525caa6de5e8d6533970bb6069568544747e8b570edd59b8a64",
  "preload/async-document-writer.cjs": "8a47e15efa73993d5162bcf0a775e4f4c7cfcafb441a70ba90dc8c6c6d6e9bbd",
  "preload/editor-navigation-diagnostics.cjs": "49698ba364d6233d73d32d73e15ba521e5fbcc86d7ea0f66578f483bd41cea31",
  "preload/exporter.cjs": "4b77806b22e45f9ae8658bd0ebfefd672e9188b08c7f2dbfd5a388ff30be7433",
  "preload/fs-workspace.cjs": "7c90bb16c20fc91c1b5fb883367b1c5fb95414d876641daab48cff9385ad0b3b",
  "preload/local-ai/compatibility.cjs": "295c24908cee069545b3877674176efa83a60ef9edb6f76218edbedd69686365",
  "preload/local-ai/deployment-lock.cjs": "34a3bc16de33b9f2eb2016c6bb4f12bc2e1bcec25114d20f25ca9c9011c05727",
  "preload/local-ai/disk-info.cjs": "e4f6ceb84efcba2086d02641a03c0bbbf42d43931c2950d7881f1f99d72d2018",
  "preload/local-ai/download-retry.cjs": "9cbef286461e9a9fb84753bf6e9aa66669d2dd35e365ed91e145ca1892bb1a06",
  "preload/local-ai/downloader.cjs": "86ea442d104313ef37fa540a6ff43ceaa1bf29b83d1b8e785856f8298d9dd072",
  "preload/local-ai/environment.cjs": "c7a920d09864892aa26e474193840a11b9160e38c51f572255b9002af9cf29a7",
  "preload/local-ai/extractor.cjs": "2202dc132d6872ce58a818d5281ab3fe73e3f24aedb1fb1ce9b3a278b24d6c3d",
  "preload/local-ai/http-transport.cjs": "0f96bdd6362622f83408f7153f2e553cf7e6e5770042da252c676fa583911e57",
  "preload/local-ai/installer.cjs": "2329b9507ed84b2957bd55681ceec62320c324845c79891b891c5f5545240765",
  "preload/local-ai/leases.cjs": "09ef81f3782cfceb0e9f0f0355e9249d117a638addb812ba7c5223f98ca63bd3",
  "preload/local-ai/managed-server.cjs": "b170e6b5c0ac0fd92f60cabfc312cea6c3ed9e4422b0d3a527ddbd739fec92e6",
  "preload/local-ai/manifest-data.json": "2c0d02c5a9f065504794116a4325f2558d0e028ab940ca908f5c439c0255c99b",
  "preload/local-ai/manifest.cjs": "bc3c82015db85f7ea1ef5b3b28feb359f03ef6d9b0dadb3e350a63a536d721ac",
  "preload/local-ai/memory-info.cjs": "c30e98b38cc1dd523f40c0f319e59333cee57577ec1bb55a531c0272fd0bb4ce",
  "preload/local-ai/output-constraint.cjs": "0491288817977f698c47f88239d69c2565a355fe3abf9dc09ea14cb7f8d8caea",
  "preload/local-ai/process-identity.cjs": "e18ce23575f4699b27da2d54e49fc46a79af94908dda7d53f17288bfaa9c7166",
  "preload/local-ai/process-lifecycle.cjs": "58e5ff759bb45c26174e7229fc84dc7f7456fd97ff27867358979c542d35b7b2",
  "preload/local-ai/request-lease.cjs": "a7c147bb3eb9512717a4b82f182686ac300114cfb3358fec35e688cf15d19a22",
  "preload/local-ai/resource-store.cjs": "7befd8d0f77126337dcd327c9c9b427b431f1499c80bd2d9f25a31fdbd385d9a",
  "preload/local-ai/service.cjs": "799f484e06042c7edd5c71728c18ef1dbfaf68943bc48667993ab364af16717a",
  "preload/local-ai/stale-lock-gate.cjs": "99f201345782f73126715c3535ac174f07698f0d0508a472f2931c17ddfa2c8d",
  "preload/local-ai/status-store.cjs": "d587dafb7f76b33b63c7311228fdd4ab76291b557e8010797276c4ceb180463d",
  "preload/mcp/builtin-tools.cjs": "e1ed4e4fb0a8869f251bef409f65fcac5922eea7c9b1ad33b286cc61f0de75c7",
  "preload/mcp/config-storage.cjs": "3ccee6de5dc024153798a3bf8085749145d9f4d31365436a4bd26c4d0da5ab2f",
  "preload/mcp/node-http-transport.cjs": "117e61bc412336c63732b77e375590f326d2abc57dba33b565dd5f4fc34b7de6",
  "preload/mcp/safe-fetch.cjs": "a6507532912a7a0932361028ab6b02ad798b5854ab939016588f4634e5ecc731",
  "preload/mcp/safe-net.cjs": "11b45a1086ecfd2a646c7579187a2f47bf5b44b447cc21ac734020fbe82a3ea7",
  "preload/mcp/service.cjs": "09ac7c41934779f4188807620c91719c988ce7fd515701a6e472eb9f25822dfd",
  "preload/mcp/streamable-http-client.cjs": "754462c720ce9c044eb961320472b93086f6ff66a4611f7c33625ec450e91496",
  "preload/services.cjs": "17b277c39cb7e0facf3af351e009c563f6a58cd051dcef77cbe68f8f2a04aeba",
  "preload/webdav-sync.cjs": "e329bd094827f43c17c4754acbf8b6a17f5b2d7016dd777a7b2dd9f61ec8a1d7",
} as const;

export type LiveMarkdownPackageCopy = {
  sourceRoot: string;
  pluginRoot: string;
  preloadPath: string;
  indexHtml: string;
  builtHashes: Record<string, { bytes: number; sha256: string }>;
  sourceDigests: Map<string, string>;
};

export async function copyReadOnlyLiveMarkdownPackage(pluginsRoot: string, scratchRoot: string): Promise<LiveMarkdownPackageCopy> {
  const sourceRoot = resolve(pluginsRoot, "live-markdown", "dist");
  const pluginRoot = join(scratchRoot, "live-markdown-built");
  const builtHashes: Record<string, { bytes: number; sha256: string }> = {};
  const sourceDigests = new Map<string, string>();
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  try {
    for (const [relative, expected] of Object.entries(pins)) {
      const source = join(sourceRoot, relative);
      const bytes = await readFile(source);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, expected, `Harris Live Markdown 0.1.0 original build hash changed: ${relative}`);
      const destination = join(pluginRoot, relative);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
      sourceDigests.set(source, sha256);
      builtHashes[relative] = { bytes: bytes.length, sha256 };
    }
    const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
    assert.equal(manifest.author, "harris");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.main, "index.html");
    assert.equal(manifest.preload, "preload/services.cjs");
    const preloadPath = join(pluginRoot, manifest.preload);
    for (const directory of [...new Set(Object.keys(pins).map(path => dirname(join(pluginRoot, path))))].sort((a, b) => b.length - a.length)) {
      await chmod(directory, 0o500);
    }
    await chmod(pluginRoot, 0o500);
    return { sourceRoot, pluginRoot, preloadPath, indexHtml: await readFile(join(pluginRoot, "index.html"), "utf8"), builtHashes, sourceDigests };
  } catch (error) {
    const directories = [...new Set(Object.keys(pins).map(path => dirname(join(pluginRoot, path))))].sort((a, b) => b.length - a.length);
    for (const directory of directories) await chmod(directory, 0o700).catch(() => {});
    await chmod(pluginRoot, 0o700).catch(() => {});
    await rm(pluginRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function assertLiveMarkdownSourceUnchanged(sourceDigests: Map<string, string>) {
  for (const [source, expected] of sourceDigests) {
    const actual = createHash("sha256").update(await readFile(source)).digest("hex");
    assert.equal(actual, expected, `Published Live Markdown build changed during the fixture: ${source}`);
  }
}

/** Restore write permission only on directories created for this immutable fixture copy before deleting its private root. */
export async function restoreOwnedCopyDirectoriesWritable(packageCopy: LiveMarkdownPackageCopy) {
  const directories = [...new Set(Object.keys(pins).map(path => dirname(join(packageCopy.pluginRoot, path))))]
    .sort((a, b) => b.length - a.length);
  for (const directory of directories) await chmod(directory, 0o700);
  return { directoriesRestored: directories.length, pluginRoot: packageCopy.pluginRoot };
}

export function liveMarkdownPinnedFile(path: string) {
  const digest = pins[path as keyof typeof pins];
  if (!digest) throw new Error(`Unexpected Live Markdown original asset: ${path}`);
  return digest;
}
