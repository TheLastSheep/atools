import { createHash } from "node:crypto";

// This stage is deliberately frozen after the TinyRDM diagnostic incident.
// An absent review is a refusal to execute, including preload and DOM hooks.
const snipasteReview = {
  "preload/services.cjs": "8901f9a187b005240028231fe60fc94c29dfb8967e264fd359f58c1d3b85910b",
  "preload/os-capture.cjs": "2998178a361673725d08d6ed36530d097ccde873b9b7f173effda45bf45841e6",
  "preload/storage-clipboard.cjs": "1bdec21734c31ceee28d9f30179a5a69aacf87436871dbf70bbc0166f33f20cd",
};

export const isReviewedMemoryProbe = descriptor => descriptor.id === "snipaste" && descriptor.ui === false && descriptor.category === "node-image-buffer-memory-only";

export async function assessFixtureExecution(descriptor, readSource) {
  if (!isReviewedMemoryProbe(descriptor)) {
    return { allowed: false, status: "not_exercised", reason: "Matrix expansion frozen pending explicit source review of top-level/DOMContentLoaded/native spawn/openExternal/install hooks and side-effect confinement." };
  }
  for (const [file, expected] of Object.entries(snipasteReview)) {
    const actual = createHash("sha256").update(await readSource(file)).digest("hex");
    if (actual !== expected) return { allowed: false, status: "not_exercised", reason: `Reviewed Snipaste source changed: ${file}` };
  }
  return { allowed: true, review: "Original three CJS files inspected: top level only imports builtins, defines functions and exposes exports; no startup hook or top-level native/file action. UI omitted entirely.",
    scope: "Only original parsePngDimensions on generated in-memory PNG and invalid/short buffers. No screenshot, fs write, clipboard, native spawn, openExternal, original UI or .runtime function is invoked.",
    reviewedSourceHashes: snipasteReview, limitation: "Source review and private environment are not an OS sandbox or a promise that arbitrary plugin code is safe." };
}
