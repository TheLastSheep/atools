import { expect, it, vi } from "vitest";
import { approvePublishedStartupDialogs } from "./nativePublishedStartupDialogPermissions";
import { approvePublishedOpenDialog, approvePublishedSaveDialog } from "./nativePublishedDialogPermission";
import { approvePublishedImageStitchDialogs } from "./nativePublishedImageStitchDialogPermission";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

vi.mock("./nativePublishedDialogPermission", () => ({
  approvePublishedOpenDialog: vi.fn(async () => ({ scope: "file_read" })),
  approvePublishedSaveDialog: vi.fn(async () => ({ scope: "file_write" })),
}));
vi.mock("./nativePublishedImageStitchDialogPermission", () => ({
  approvePublishedImageStitchDialogs: vi.fn(async () => ({ open: { scope: "file_read" }, save: { scope: "file_write" } })),
}));

function context(dialogAccess: "none" | "open" | "save" | "open_and_save") {
  return { profile: { dialogAccess }, setPhase: vi.fn() } as unknown as PublishedScenarioContext;
}

it("keeps the existing save-only and DeepRead open-only approval routes", async () => {
  const save = context("save");
  expect(await approvePublishedStartupDialogs(save)).toEqual({ saveDialogBeforePermission: { scope: "file_write" } });
  expect(save.setPhase).toHaveBeenCalledWith("real-startup-save-metadata-authorization");
  expect(approvePublishedSaveDialog).toHaveBeenCalledWith(save);

  const open = context("open");
  expect(await approvePublishedStartupDialogs(open)).toEqual({ openDialogBeforePermission: { scope: "file_read" } });
  expect(open.setPhase).toHaveBeenCalledWith("real-startup-open-metadata-authorization");
  expect(approvePublishedOpenDialog).toHaveBeenCalledWith(open);
});

it("uses the pinned Image Stitch dual-grant flow and leaves no-dialog profiles untouched", async () => {
  const combined = context("open_and_save");
  expect(await approvePublishedStartupDialogs(combined)).toEqual({
    imageStitchDialogPermissions: { open: { scope: "file_read" }, save: { scope: "file_write" } },
  });
  expect(approvePublishedImageStitchDialogs).toHaveBeenCalledWith(combined);
  expect(combined.setPhase).not.toHaveBeenCalled();

  const none = context("none");
  expect(await approvePublishedStartupDialogs(none)).toBeNull();
  expect(none.setPhase).not.toHaveBeenCalled();
  expect(approvePublishedOpenDialog).not.toHaveBeenCalledWith(none);
  expect(approvePublishedSaveDialog).not.toHaveBeenCalledWith(none);
});
