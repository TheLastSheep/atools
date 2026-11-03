import type { PublishedPluginProfile } from "./nativePublishedPluginCommon";

/** Exact current-host gate for the reviewed original package; runtime stays Web. */
export const IMAGE_STITCH_PROFILE: PublishedPluginProfile = Object.freeze({
  caseId: "local-image-stitch-head",
  id: "image-stitch",
  version: "1.0.0",
  sourceKind: "local_full_directory",
  sourcePath: "ZTools-plugins/plugins/image-stitch",
  sourceCommit: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
  sourceTree: "629b6c70b86f28d8f775ced7202bfc2de9b244d5",
  directorySha256: "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee",
  fileCount: 5,
  featureCode: "image-stitch-files",
  searchQuery: "拼接图片",
  title: "图片拼接",
  runtime: "web",
  dataAccess: true,
  dialogAccess: "open_and_save",
  pathAccess: "none",
  verifyDataPersistence: false,
  sourceReview: "output/legacy-node-2026-10-21/local-image-stitch-head-source-review-v1.json",
  frameOperations: "tests/components/nativeOriginalImageStitchFrameOperations.js",
  sourceReviewStatus: "prepared_for_parent_native_fixture_decision",
});

export function isExactImageStitchProfile(value: unknown): value is PublishedPluginProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const expected = IMAGE_STITCH_PROFILE as unknown as Record<string, unknown>;
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => actual[key] === item);
}
