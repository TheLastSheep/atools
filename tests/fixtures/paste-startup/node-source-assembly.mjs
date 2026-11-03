import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors the production BOOTSTRAP include_str! ordering without granting
 * these source files to the isolated Product Node process. */
export const pasteNodeRuntimeSourceFiles = Object.freeze([
  "crates/atools-plugin/src/legacy_node/codec.cjs",
  "crates/atools-plugin/src/legacy_node/bounded_png_path.cjs",
  "crates/atools-plugin/src/legacy_node/bounded_native_image_path.cjs",
  "crates/atools-plugin/src/legacy_node/managed_child_transport.cjs",
  "crates/atools-plugin/src/legacy_node/managed_child_streams.cjs",
  "crates/atools-plugin/src/legacy_node/managed_children.cjs",
  "crates/atools-plugin/src/legacy_node/bootstrap.cjs",
]);

export async function assemblePasteNodeRuntimeSource(root, policySource) {
  if (typeof root !== "string" || !root || typeof policySource !== "string") {
    throw new TypeError("Paste Node source assembly requires a repository root and fixture policy source");
  }
  const sources = await Promise.all(pasteNodeRuntimeSourceFiles.map(path => readFile(join(root, path))));
  const chunks = [Buffer.from(policySource, "utf8"), Buffer.from("\n", "utf8")];
  sources.forEach((source, index) => {
    chunks.push(source);
    if (index + 1 < sources.length) chunks.push(Buffer.from("\n", "utf8"));
  });
  return Buffer.concat(chunks).toString("utf8");
}
