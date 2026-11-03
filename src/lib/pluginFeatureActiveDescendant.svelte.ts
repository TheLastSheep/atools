import type { PluginFeatureList } from "./pluginFeatureExportsState";
import { pluginFeatureOptionId } from "./pluginFeatureA11yIds";

export type FeatureActiveOptionIdentity = {
  owner: symbol;
  listboxId: string;
  epoch: number;
  entry: number;
  revision: number;
  selected: number;
};

export type FeatureActiveOptionReport = FeatureActiveOptionIdentity & {
  rendered: boolean;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
};

function sameIdentity(left: FeatureActiveOptionIdentity, right: FeatureActiveOptionIdentity) {
  return left.owner === right.owner && left.listboxId === right.listboxId && left.epoch === right.epoch
    && left.entry === right.entry && left.revision === right.revision && left.selected === right.selected;
}

export function createPluginFeatureActiveDescendantController() {
  let activeReport = $state<FeatureActiveOptionReport | undefined>();

  function report(value: FeatureActiveOptionReport | null, identity: FeatureActiveOptionIdentity) {
    if (value === null) {
      if (activeReport && sameIdentity(activeReport, identity)) activeReport = undefined;
      return;
    }
    const valid = value.listboxId.length > 0 && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.entry)
      && value.entry > 0 && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.selected)
      && value.selected >= 0 && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
      && Number.isFinite(value.viewportHeight) && value.viewportHeight > 0
      && Number.isFinite(value.rowHeight) && value.rowHeight > 0;
    if (valid) activeReport = value;
    else if (activeReport && sameIdentity(activeReport, value)) activeReport = undefined;
  }

  function activeDescendantIdFor(model: PluginFeatureList, listboxId: string): string | undefined {
    const report = activeReport;
    if (!report || model.mode !== "list" || report.listboxId !== listboxId || report.epoch !== model.epoch
      || report.entry !== model.entry || report.revision !== model.revision || report.selected !== model.selected
      || model.rows[model.selected]?.index !== model.selected || !report.rendered) return undefined;
    const top = model.selected * report.rowHeight;
    const bottom = top + report.rowHeight;
    const viewportBottom = report.scrollTop + report.viewportHeight;
    if (![top, bottom, viewportBottom].every(Number.isFinite)) return undefined;
    if (!(top < viewportBottom && bottom > report.scrollTop)) return undefined;
    return pluginFeatureOptionId(listboxId, model.selected);
  }

  return { report, activeDescendantIdFor };
}
