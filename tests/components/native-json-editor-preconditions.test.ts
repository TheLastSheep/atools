import { describe, expect, it } from "vitest";
import { jsonEditorFrameUiReady, jsonEditorNativeUiReady } from "./nativeJsonEditorPreconditions";

const nativeReady = {
  appActive: true,
  appHidden: false,
  frontmostIsSelf: true,
  nativeFocused: true,
  nativeVisible: true,
  windowOcclusionVisible: true,
};

describe("jsonEditorNativeUiReady", () => {
  it("requires every positive native and host visibility signal", () => {
    expect(jsonEditorNativeUiReady(nativeReady, "visible")).toBe(true);
    expect(jsonEditorNativeUiReady(nativeReady, "hidden")).toBe(false);
    expect(jsonEditorNativeUiReady(nativeReady, undefined)).toBe(false);
    expect(jsonEditorNativeUiReady(nativeReady, null)).toBe(false);
  });

  it.each([
    ["appActive", undefined], ["appActive", false], ["appActive", "true"],
    ["appHidden", undefined], ["appHidden", true], ["appHidden", 0],
    ["frontmostIsSelf", undefined], ["frontmostIsSelf", false], ["frontmostIsSelf", 1],
    ["nativeFocused", undefined], ["nativeFocused", false], ["nativeFocused", "yes"],
    ["nativeVisible", undefined], ["nativeVisible", false], ["nativeVisible", 1],
    ["windowOcclusionVisible", undefined], ["windowOcclusionVisible", null],
    ["windowOcclusionVisible", false], ["windowOcclusionVisible", "visible"],
  ] as const)("rejects missing, false, or unknown %s=%s evidence", (field, value) => {
    expect(jsonEditorNativeUiReady({ ...nativeReady, [field]: value }, "visible")).toBe(false);
  });

  it.each([null, undefined, false, 1, "visible", [], new Error("unavailable")])(
    "rejects malformed native evidence %s",
    value => expect(jsonEditorNativeUiReady(value, "visible")).toBe(false),
  );

  it("fails closed if a native evidence getter throws", () => {
    const throwing = Object.defineProperty({}, "appActive", { get: () => { throw new Error("missing"); } });
    expect(jsonEditorNativeUiReady(throwing, "visible")).toBe(false);
  });
});

describe("jsonEditorFrameUiReady", () => {
  it("accepts only an explicitly visible document", () => {
    expect(jsonEditorFrameUiReady({ documentHidden: false, visibilityState: "visible" })).toBe(true);
    expect(jsonEditorFrameUiReady({ documentHidden: false, visibilityState: "hidden" })).toBe(false);
    expect(jsonEditorFrameUiReady({ documentHidden: true, visibilityState: "visible" })).toBe(false);
    expect(jsonEditorFrameUiReady({ visibilityState: "visible" })).toBe(false);
    expect(jsonEditorFrameUiReady({ documentHidden: false })).toBe(false);
  });

  it.each([null, undefined, false, 1, "visible", [], new Error("unavailable")])(
    "rejects malformed frame visibility evidence %s",
    value => expect(jsonEditorFrameUiReady(value)).toBe(false),
  );

  it("does not require the textarea to own focus", () => {
    expect(jsonEditorFrameUiReady({
      documentHidden: false,
      visibilityState: "visible",
      textareaActive: false,
    })).toBe(true);
  });

  it("fails closed if a frame evidence getter throws", () => {
    const throwing = Object.defineProperty({}, "documentHidden", { get: () => { throw new Error("missing"); } });
    expect(jsonEditorFrameUiReady(throwing)).toBe(false);
  });
});
