import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { approvePublishedImageStitchDialogs } from "./nativePublishedImageStitchDialogPermission";
import { approvePublishedOpenDialog, approvePublishedSaveDialog } from "./nativePublishedDialogPermission";

/** Routes each pinned startup dialog profile to its existing exact one-time approval flow. */
export async function approvePublishedStartupDialogs(context: PublishedScenarioContext): Promise<Record<string, unknown> | null> {
  if (context.profile.dialogAccess === "open_and_save") {
    return { imageStitchDialogPermissions: await approvePublishedImageStitchDialogs(context) };
  }
  if (context.profile.dialogAccess === "save") {
    context.setPhase("real-startup-save-metadata-authorization");
    return { saveDialogBeforePermission: await approvePublishedSaveDialog(context) };
  }
  if (context.profile.dialogAccess === "open") {
    context.setPhase("real-startup-open-metadata-authorization");
    return { openDialogBeforePermission: await approvePublishedOpenDialog(context) };
  }
  return null;
}
