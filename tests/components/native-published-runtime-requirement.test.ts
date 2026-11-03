import { expect, it } from "vitest";
import { requiresLegacyNodeSession } from "./nativePublishedRuntimeRequirement";
import { IMAGE_STITCH_PROFILE } from "./nativePublishedImageStitchContract";
import type { PublishedPluginProfile } from "./nativePublishedPluginCommon";

it("requires the current legacy Node session only for the exact pinned Image Stitch Web profile", () => {
  expect(IMAGE_STITCH_PROFILE.runtime).toBe("web");
  expect(requiresLegacyNodeSession(IMAGE_STITCH_PROFILE)).toBe(true);
  expect(requiresLegacyNodeSession({ ...IMAGE_STITCH_PROFILE, id: "other" })).toBe(false);
  expect(requiresLegacyNodeSession({ ...IMAGE_STITCH_PROFILE, sourceTree: "0".repeat(40) })).toBe(false);
  expect(requiresLegacyNodeSession({ ...IMAGE_STITCH_PROFILE, caseId: "unregistered-web" })).toBe(false);
});

it("keeps pure Web packages on the zero-Node route and existing Node or preload profiles enabled", () => {
  const pureWeb = { ...IMAGE_STITCH_PROFILE, caseId: "pure-web-fixture", id: "pure-web", dialogAccess: "none" } as PublishedPluginProfile;
  const nodePackage: PublishedPluginProfile = { ...pureWeb, runtime: "node" };
  const deepReadPage: PublishedPluginProfile = { ...pureWeb, caseId: "converted-deepread-source", runtime: "web" };
  expect(requiresLegacyNodeSession(pureWeb)).toBe(false);
  expect(requiresLegacyNodeSession(nodePackage)).toBe(true);
  expect(requiresLegacyNodeSession(deepReadPage)).toBe(true);
});
