import { expect, it } from "vitest";
import { safeDiagnostic } from "./nativePluginBrowserWindowScenario";

it.each([
  ["dom-click-arm", "ORIGINAL_MENU_DOM_CLICK_ARM_FAILED"],
  ["dom-click-trigger", "ORIGINAL_MENU_DOM_CLICK_TRIGGER_FAILED"],
  ["dom-click", "ORIGINAL_MENU_DOM_CLICK_FAILED"],
])("retains the fixed %s menu failure through final scenario filtering", (step, knownErrorCode) => {
  expect(safeDiagnostic({ step, knownErrorCode, errorClass: "Error", message: "private payload" }))
    .toEqual({ step, knownErrorCode, errorClass: "Error" });
});

it("rejects arbitrary step, error class, code and free text", () => {
  const valid = { step: "dom-click-arm", errorClass: "Error", knownErrorCode: "ORIGINAL_MENU_DOM_CLICK_ARM_FAILED" };
  for (const field of ["step", "errorClass", "knownErrorCode"]) {
    expect(safeDiagnostic({ ...valid, [field]: "private payload" })).toBeNull();
  }
  expect(safeDiagnostic("private payload")).toBeNull();
});

it.each(["GEOMETRY_CREATE_FAILED", "GEOMETRY_READY_REJECTED", "GEOMETRY_SYNCHRONOUS_CONTRACT_FAILED",
  "GEOMETRY_MOVE_UNCONFIRMED", "GEOMETRY_RESIZE_UNCONFIRMED", "GEOMETRY_NESTED_REJECTED"])("retains fixed geometry failure %s without free text", knownErrorCode => {
  expect(safeDiagnostic({ step: "scenario-check", knownErrorCode, errorClass: "Error", message: "private payload" }))
    .toEqual({ step: "scenario-check", knownErrorCode, errorClass: "Error" });
});
