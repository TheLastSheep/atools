import { describe, expect, it } from "vitest";
import { projectDeepReadImportSnapshot } from "./nativeDeepReadImportProjection";

const expectedBytes = 8854;
const expectedHash = "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0";
const snapshot = {
  bookCount: 1, fixtureBookPresent: true, lastBookSelected: true, pathStored: true,
  contentBytes: expectedBytes, progressIndex: 0, contentSha256: expectedHash,
};

describe("DeepRead import snapshot projection", () => {
  it("projects only bounded counts and match booleans without sensitive snapshot fields", () => {
    const withSensitiveExtras = Object.assign({}, snapshot, {
      path: "/private/tmp/secret.txt", key: "private-key", title: "Private title", content: "Private body", id: "private-id",
    });
    const projected = projectDeepReadImportSnapshot(withSensitiveExtras, expectedBytes, expectedHash);
    expect(projected).toEqual({
      bookCount: 1, fixtureBookPresent: true, lastBookSelected: true, pathStored: true,
      contentBytes: expectedBytes, progressIndex: 0,
      contentBytesMatchesExpected: true, contentHashMatchesExpected: true,
    });
    expect(Object.keys(projected)).toEqual(["bookCount", "fixtureBookPresent", "lastBookSelected", "pathStored",
      "contentBytes", "progressIndex", "contentBytesMatchesExpected", "contentHashMatchesExpected"]);
    expect(JSON.stringify(projected)).not.toContain("/private/tmp/secret.txt");
    expect(JSON.stringify(projected)).not.toContain("Private body");
    expect(JSON.stringify(projected)).not.toContain("Private title");
    expect(JSON.stringify(projected)).not.toContain("private-id");
  });

  it("distinguishes wrong size or digest without projecting either digest value", () => {
    const wrongSize = projectDeepReadImportSnapshot({ ...snapshot, contentBytes: expectedBytes + 1 }, expectedBytes, expectedHash);
    const wrongHash = projectDeepReadImportSnapshot({ ...snapshot, contentSha256: "0".repeat(64) }, expectedBytes, expectedHash);
    expect(wrongSize.contentBytesMatchesExpected).toBe(false);
    expect(wrongSize.contentHashMatchesExpected).toBe(true);
    expect(wrongHash.contentBytesMatchesExpected).toBe(true);
    expect(wrongHash.contentHashMatchesExpected).toBe(false);
    expect(JSON.stringify([wrongSize, wrongHash])).not.toContain(expectedHash);
  });

  it("nulls out out-of-budget counts instead of emitting unbounded values", () => {
    const projected = projectDeepReadImportSnapshot({ ...snapshot, bookCount: 51,
      contentBytes: Number.MAX_SAFE_INTEGER, progressIndex: Number.MAX_SAFE_INTEGER }, expectedBytes, expectedHash);
    expect(projected).toMatchObject({ bookCount: null, contentBytes: null, progressIndex: null });
  });
});
