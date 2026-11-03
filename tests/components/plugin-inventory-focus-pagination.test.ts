import { expect, it } from "vitest";
import { createPluginInventoryFocusPaginationController } from "../../src/lib/pluginInventoryFocusPagination";

const request = {
  direction: "next" as const,
  fromPage: 1,
  toPage: 2,
  originPluginId: "item-29",
  targetPluginId: "item-30",
};

it("claims one adjacent-page focus handoff and consumes it only for the current visible target", () => {
  const controller = createPluginInventoryFocusPaginationController();
  const token = controller.begin(request)!;
  expect(controller.begin(request)).toBeNull();
  expect(controller.complete(token, 2, ["item-30", "item-31"], true)).toBe("item-30");
  expect(controller.complete(token, 2, ["item-30"], true)).toBeNull();
});

it("rejects stale, wrong-page, missing-target, and focus-lost handoffs", () => {
  const controller = createPluginInventoryFocusPaginationController();
  const stale = controller.begin(request)!;
  controller.invalidate();
  expect(controller.complete(stale, 2, ["item-30"], true)).toBeNull();

  const wrongPage = controller.begin(request)!;
  expect(controller.complete(wrongPage, 1, ["item-30"], true)).toBeNull();

  const missingTarget = controller.begin(request)!;
  expect(controller.complete(missingTarget, 2, ["item-31"], true)).toBeNull();

  const lostFocus = controller.begin(request)!;
  expect(controller.complete(lostFocus, 2, ["item-30"], false)).toBeNull();
});

it("accepts only a one-page move in the requested direction with distinct row identities", () => {
  const controller = createPluginInventoryFocusPaginationController();
  expect(controller.begin({ ...request, toPage: 3 })).toBeNull();
  expect(controller.begin({ ...request, direction: "previous", toPage: 2 })).toBeNull();
  expect(controller.begin({ ...request, targetPluginId: request.originPluginId })).toBeNull();
  expect(controller.begin({ ...request, originPluginId: "" })).toBeNull();
});
