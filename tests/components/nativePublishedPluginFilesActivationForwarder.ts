import type { DesktopSmokeFilesActivation } from "../../src/lib/desktopSmokeFilesActivationContract";
import type { PublishedFilesActivation } from "./nativePublishedPluginCommon";

/** Keeps the context callback's two distinct argument tuples intact across the App ready callback. */
export function createPublishedFilesActivationForwarder(getActivation: () => DesktopSmokeFilesActivation | undefined): PublishedFilesActivation {
  function forward(code: string, paths: readonly [string], expectedPluginId: string): Promise<void>;
  function forward(code: "image-stitch-files", paths: readonly [string, string], expectedPluginId: "image-stitch", expectedRunId: string): Promise<void>;
  function forward(code: string, paths: readonly string[], expectedPluginId: string, expectedRunId?: string): Promise<void> {
    const activation = getActivation();
    if (!activation) throw new Error("App desktop-smoke activation port is unavailable");
    if (code === "image-stitch-files") {
      if (expectedPluginId !== "image-stitch" || !expectedRunId || paths.length !== 2) {
        throw new Error("Image Stitch activation identity is incomplete");
      }
      return activation("image-stitch-files", paths as readonly [string, string], "image-stitch", expectedRunId);
    }
    if (code !== "deepread-import" || expectedPluginId !== "deepread" || expectedRunId !== undefined || paths.length !== 1) {
      throw new Error("DeepRead activation identity is incomplete");
    }
    return activation("deepread-import", paths as readonly [string], "deepread");
  }
  return forward;
}
