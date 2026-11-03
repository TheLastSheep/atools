import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { captureRendererHostSources } from "./ztools-renderer-host-sources.mjs";

export function createZtoolsRendererBrowserSourceLock({ root, upstream, packageRoot, distRoot, fixtureFiles }) {
  function runGit(args) {
    return execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  async function filesUnder(directory) {
    const files = [];
    async function walk(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(absolute);
      }
    }
    await walk(directory);
    return files.sort();
  }

  function sha(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  }

  async function hashFiles(files, base = root) {
    const result = {};
    for (const file of [...files].sort()) {
      result[relative(base, file).split(sep).join("/")] = sha(await readFile(file));
    }
    return result;
  }

  async function hashUpstreamTree() {
    const tracked = runGit(["ls-files", "-z", "--", "src/renderer", "src/shared", "LICENSE", "package.json", "pnpm-lock.yaml"])
      .split("\0").filter(Boolean).sort();
    assert.ok(tracked.includes("src/renderer/index.html") && tracked.includes("src/renderer/src/main.ts"));
    const digest = createHash("sha256");
    let bytes = 0;
    for (const path of tracked) {
      const content = await readFile(join(upstream, path));
      digest.update(path).update("\0").update(content).update("\0");
      bytes += content.byteLength;
    }
    return {
      commit: runGit(["rev-parse", "HEAD"]),
      dirty: runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
      sha256: digest.digest("hex"),
      files: tracked.length,
      bytes,
    };
  }

  async function sourceHashes() {
    const packageSource = await filesUnder(join(packageRoot, "src"));
    const declaredSources = await captureRendererHostSources(packageRoot);
    return hashFiles([...new Set([...fixtureFiles.map(file => join(root, file)), ...packageSource,
      join(packageRoot, "source-manifest.json"), ...declaredSources.map(source => join(packageRoot, source.path))])]);
  }

  async function readHostAdapterSources() {
    return captureRendererHostSources(packageRoot);
  }

  async function distHashes() {
    return hashFiles(await filesUnder(distRoot), root);
  }

  return Object.freeze({ filesUnder, hashUpstreamTree, sourceHashes, readHostAdapterSources, distHashes });
}
