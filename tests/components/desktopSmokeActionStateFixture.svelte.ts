import type { FeatureAction } from "../../src/lib/types";

/** Exercises the same deep proxy boundary that App.svelte's $state applies to activePlugin. */
export function createDesktopSmokeActionStateFixture(action: FeatureAction) {
  let activeAction = $state(action);
  return {
    get activeAction(): FeatureAction {
      return activeAction;
    },
  };
}
