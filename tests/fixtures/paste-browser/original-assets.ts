import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const pasteBrowserPins = [
  { path: "assets/index-4mPfCjok.js", bytes: 257678, sha256: "1b2c8707c70131dacc782a55a949bf43b8a75c390633b0f880835b9e1503bfe2", contentType: "text/javascript; charset=utf-8" },
  { path: "assets/index-Cu7SjoI2.css", bytes: 68597, sha256: "5da7c41ec84c48edfc9d0ceb31e54a2f33e7393c32f02fcc237b31872838ecd4", contentType: "text/css; charset=utf-8" },
  { path: "logo.png", bytes: 241870, sha256: "fd3e919353fb07c5ef8bb4c1214a50b308a96d1705d569e01797bcb950611ef0", contentType: "image/png" },
] as const;

/** Extends Task14's immutable package copy with only its three pinned Vue assets. */
export async function copyPinnedPasteBrowserAssets(
  sourceRoot: string,
  pluginRoot: string,
  sourceDigests: Map<string, string>,
) {
  const hashes: Record<string, string> = {};
  await chmod(pluginRoot, 0o700);
  try {
    for (const pin of pasteBrowserPins) {
      const source = join(sourceRoot, pin.path);
      const bytes = await readFile(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.equal(bytes.length, pin.bytes, `Paste browser asset byte length changed: ${pin.path}`);
      assert.equal(digest, pin.sha256, `Paste browser asset hash changed: ${pin.path}`);
      const destination = join(pluginRoot, pin.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o400, flag: "wx" });
      await chmod(destination, 0o400);
      sourceDigests.set(source, digest);
      hashes[pin.path] = digest;
    }
  } finally {
    await chmod(join(pluginRoot, "assets"), 0o500).catch(() => {});
    await chmod(pluginRoot, 0o500);
  }
  return hashes;
}

export function pasteBrowserPin(path: string) {
  const pin = pasteBrowserPins.find(candidate => candidate.path === path);
  if (!pin) throw new Error(`Unexpected original Paste browser resource: ${path}`);
  return pin;
}
