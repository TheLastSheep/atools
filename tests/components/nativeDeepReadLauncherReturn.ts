import { launcherInput } from "./nativePublishedPluginCommon";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

/** Uses the scenario’s existing bounded wait for panel removal, input mount, and focus together. */
export async function waitForDeepReadLauncherReturn(
  context: Pick<PublishedScenarioContext, "until" | "check" | "passivePluginReturn">,
  returnAttempted = false,
) {
  if (returnAttempted) context.passivePluginReturn?.markAttempted();
  try {
    const input = await context.until(
      () => {
        if (document.querySelector(".plugin-panel")) return null;
        const mounted = launcherInput();
        return mounted && document.activeElement === mounted ? mounted : null;
      },
      "DeepRead panel did not return to the production launcher",
    );
    context.check(input, "DeepRead launcher input is mounted");
    context.check(document.activeElement === input, "DeepRead launcher input regained focus");
    return input;
  } finally {
    if (returnAttempted) await context.passivePluginReturn?.observeSettled();
  }
}
