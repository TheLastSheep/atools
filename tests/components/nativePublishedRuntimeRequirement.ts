import type { PublishedPluginProfile } from "./nativePublishedPluginCommon";
import { isExactImageStitchProfile } from "./nativePublishedImageStitchContract";

const NODE_PRELOAD_CASES = new Set(["converted-deepread-source"]);
const DISPLAY_PRELOAD_CASES = new Set(["converted-deepread-source"]);

/** UI runtime and preload runtime are separate: this fixed web UI ships a Node-dependent preload. */
export function requiresLegacyNodeSession(profile: PublishedPluginProfile | Pick<PublishedPluginProfile, "caseId" | "runtime">) {
  return profile.runtime === "node" || NODE_PRELOAD_CASES.has(profile.caseId) || isExactImageStitchProfile(profile);
}

/** The fixed DeepRead source calls getPrimaryDisplay during its original page startup. */
export function requiresPluginDisplaySession(profile: Pick<PublishedPluginProfile, "caseId" | "id" | "title">) {
  return profile.caseId === "converted-deepread-source" && profile.id === "deepread" && profile.title === "DeepRead 深读"
    && DISPLAY_PRELOAD_CASES.has(profile.caseId);
}
