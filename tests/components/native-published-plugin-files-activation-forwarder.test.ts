import { expect, it, vi } from "vitest";
import type { DesktopSmokeFilesActivation } from "../../src/lib/desktopSmokeFilesActivationContract";
import { createPublishedFilesActivationForwarder } from "./nativePublishedPluginFilesActivationForwarder";

it("preserves the run-bound ordered two-file Image Stitch signature at the App boundary", async () => {
  const activate = vi.fn(async () => {});
  const paths = ["/fixture/top.png", "/fixture/bottom.png"] as const;
  await createPublishedFilesActivationForwarder(() => activate as DesktopSmokeFilesActivation)(
    "image-stitch-files", paths, "image-stitch", "run-1");
  expect(activate).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith("image-stitch-files", paths, "image-stitch", "run-1");
});

it("keeps DeepRead's existing three-argument single-path route unchanged", async () => {
  const activate = vi.fn(async () => {});
  const paths = ["/fixture/book.txt"] as const;
  await createPublishedFilesActivationForwarder(() => activate as DesktopSmokeFilesActivation)("deepread-import", paths, "deepread");
  expect(activate).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith("deepread-import", paths, "deepread");
});

it("does not silently discard the required run identity or call a missing port", async () => {
  const forward = createPublishedFilesActivationForwarder(() => undefined);
  expect(() => forward("image-stitch-files", ["/a", "/b"], "image-stitch", "run-2")).toThrow("port is unavailable");
});
