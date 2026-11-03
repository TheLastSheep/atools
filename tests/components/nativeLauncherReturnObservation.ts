type ActiveElementCategory =
  | "launcher-input"
  | "plugin-panel-control"
  | "other-input"
  | "button"
  | "body"
  | "document-element"
  | "other"
  | "none";

export type LauncherReturnDomObservation = {
  pluginPanelPresent: boolean;
  iframePresent: boolean;
  launcherInputPresent: boolean;
  launcherInputFocused: boolean;
  activeElementCategory: ActiveElementCategory;
  documentHasFocus: boolean;
  visibilityState: "visible" | "hidden" | "other";
};

export function launcherSnapshot() {
  const input = document.querySelector<HTMLInputElement>(".search-input");
  return { inputValue: input?.value ?? null, inputFocused: document.activeElement === input,
    rows: [...document.querySelectorAll<HTMLElement>('[role="option"]')].slice(0, 24).map(node => ({
      pluginId: node.dataset.pluginId, code: node.dataset.resultCode,
      selected: node.getAttribute("aria-selected") === "true", label: node.querySelector(".result-title")?.textContent,
    })) };
}

/** Emits only bounded presence/focus facts; no selectors, text, values, or DOM snapshots. */
export function observeLauncherReturnState(doc: Document): LauncherReturnDomObservation {
  const panel = doc.querySelector<HTMLElement>(".plugin-panel");
  const iframe = doc.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  const input = doc.querySelector<HTMLInputElement>('[data-atools-search-input="true"]');
  const active = doc.activeElement;
  let activeElementCategory: ActiveElementCategory = "other";

  if (!active) activeElementCategory = "none";
  else if (active === input) activeElementCategory = "launcher-input";
  else if (panel?.contains(active)) activeElementCategory = "plugin-panel-control";
  else if (active === doc.body) activeElementCategory = "body";
  else if (active === doc.documentElement) activeElementCategory = "document-element";
  else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) {
    activeElementCategory = "other-input";
  } else if (active instanceof HTMLButtonElement) activeElementCategory = "button";

  return {
    pluginPanelPresent: panel !== null,
    iframePresent: iframe !== null,
    launcherInputPresent: input !== null,
    launcherInputFocused: input !== null && active === input,
    activeElementCategory,
    documentHasFocus: doc.hasFocus(),
    visibilityState: doc.visibilityState === "visible" ? "visible" : doc.visibilityState === "hidden" ? "hidden" : "other",
  };
}
