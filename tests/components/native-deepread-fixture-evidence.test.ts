import { describe, expect, it } from "vitest";
import { assertDeepReadFixtureEvidence } from "./nativeDeepReadFixtureEvidence";

const base = { content: "fixed deterministic multipage text omitted", fileName: "ATools-DeepRead-Reader-Fixture.txt",
  path: "/private/tmp/atools-fixture-environment-test/home/Downloads/ATools-DeepRead-Reader-Fixture.txt",
  readOnly: true, storedContentBytes: 8854, storedContentSha256: "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0",
  title: "ATools DeepRead Reader Fixture" };

describe("DeepRead fixed fixture encoding evidence", () => {
  it("preserves the default raw ASCII identity and requires the explicit BOM raw identity", () => {
    expect(assertDeepReadFixtureEvidence({ ...base, bytes: 8856,
      sha256: "81f1d61593517a97f8f206e0df298e45bdabeaa99fc99d32009eb3b80c50ac83" }).textEncoding).toBe("ascii");
    const bom = assertDeepReadFixtureEvidence({ ...base, bytes: 8859,
      sha256: "238396bdcc00c617be26664adeca4c60d72bfa9f2ef9ef074632c73a4cc76052", textEncoding: "utf8-bom" }, "utf8-bom");
    expect(bom.textEncoding).toBe("utf8-bom");
    expect(bom.storedContentBytes).toBe(8854);
    expect(bom.storedContentSha256).toBe("7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0");
  });
  it("rejects unrequested variant, wrong raw pins, mismatched normalization and private fields", () => {
    const bom = { ...base, bytes: 8859, sha256: "238396bdcc00c617be26664adeca4c60d72bfa9f2ef9ef074632c73a4cc76052", textEncoding: "utf8-bom" };
    expect(() => assertDeepReadFixtureEvidence(bom)).toThrow();
    expect(() => assertDeepReadFixtureEvidence({ ...bom, bytes: 8856 }, "utf8-bom")).toThrow();
    expect(() => assertDeepReadFixtureEvidence({ ...bom, storedContentBytes: 8856 }, "utf8-bom")).toThrow();
    expect(() => assertDeepReadFixtureEvidence({ ...bom, path: "/Users/person/Downloads/book.txt" }, "utf8-bom")).toThrow();
    expect(() => assertDeepReadFixtureEvidence({ ...bom, rawContent: "secret" }, "utf8-bom")).toThrow();
  });
});
