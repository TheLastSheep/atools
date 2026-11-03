import { describe, expect, it } from "vitest";
import { emptyPluginFeatureList, featureListMessage } from "../../src/lib/pluginFeatureExportsState";
import { createPluginFeatureActiveDescendantController, type FeatureActiveOptionIdentity, type FeatureActiveOptionReport } from "../../src/lib/pluginFeatureActiveDescendant.svelte.js";
import { pluginFeatureOptionId } from "../../src/lib/pluginFeatureA11yIds";

function model(selected = 0) {
  return featureListMessage(emptyPluginFeatureList(4), {
    __atools_feature_exports__: true, epoch: 4, entry: 2, revision: 9, mode: "list", selected, selectable: true,
    rows: Array.from({ length: 20 }, (_, index) => ({ index, title: `Item ${index}`, description: "", icon: "" })),
  })!;
}

function fixture(overrides: Partial<FeatureActiveOptionReport> = {}) {
  const identity: FeatureActiveOptionIdentity = { owner: Symbol("owner"), listboxId: "features-a", epoch: 4, entry: 2, revision: 9, selected: 0 };
  return { identity, report: { ...identity, rendered: true, scrollTop: 0, viewportHeight: 128, rowHeight: 64, ...overrides } };
}

describe("plugin feature active descendant controller", () => {
  it("publishes only a current rendered option intersecting a measured viewport", () => {
    const controller = createPluginFeatureActiveDescendantController();
    const { identity, report } = fixture();
    controller.report(report, identity);
    expect(controller.activeDescendantIdFor(model(), identity.listboxId)).toBe(pluginFeatureOptionId(identity.listboxId, 0));
    expect(controller.activeDescendantIdFor({ ...model(), revision: 10 }, identity.listboxId)).toBeUndefined();
    expect(controller.activeDescendantIdFor({ ...model(), entry: 3 }, identity.listboxId)).toBeUndefined();
    expect(controller.activeDescendantIdFor({ ...model(), mode: "none" }, identity.listboxId)).toBeUndefined();
    controller.report({ ...report, rendered: false }, identity);
    expect(controller.activeDescendantIdFor(model(), identity.listboxId)).toBeUndefined();
  });

  it("does not publish when the real viewport is zero or overscan only", () => {
    const controller = createPluginFeatureActiveDescendantController();
    const { identity, report } = fixture({ viewportHeight: 0 });
    controller.report(report, identity);
    expect(controller.activeDescendantIdFor(model(), identity.listboxId)).toBeUndefined();
    controller.report({ ...report, viewportHeight: 128 }, identity);
    expect(controller.activeDescendantIdFor(model(), identity.listboxId)).toBe(pluginFeatureOptionId(identity.listboxId, 0));
    controller.report({ ...report, viewportHeight: 128, scrollTop: 64, rendered: true }, identity);
    expect(controller.activeDescendantIdFor(model(), identity.listboxId)).toBeUndefined();
  });

  it("ignores stale cleanup and invalid reports from another component instance", () => {
    const controller = createPluginFeatureActiveDescendantController();
    const current = fixture();
    controller.report(current.report, current.identity);
    const stale = fixture({ owner: Symbol("stale"), revision: 8 });
    controller.report(null, stale.identity);
    controller.report({ ...stale.report, viewportHeight: Number.NaN }, stale.identity);
    expect(controller.activeDescendantIdFor(model(), current.identity.listboxId)).toBe(pluginFeatureOptionId(current.identity.listboxId, 0));
    controller.report(null, current.identity);
    expect(controller.activeDescendantIdFor(model(), current.identity.listboxId)).toBeUndefined();
  });
});
