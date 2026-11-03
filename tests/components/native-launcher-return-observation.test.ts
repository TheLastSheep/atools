import { afterEach, expect, it } from "vitest";
import { observeLauncherReturnState } from "./nativeLauncherReturnObservation";

afterEach(() => { document.body.replaceChildren(); });

it("distinguishes a closed plugin frame from a rendered but unfocused launcher using bounded facts", () => {
  const panel = document.createElement("section"); panel.className = "plugin-panel";
  const back = document.createElement("button"); panel.append(back); document.body.append(panel);
  const iframe = document.createElement("iframe"); iframe.title = "Plugin"; panel.append(iframe);
  const input = document.createElement("input"); input.dataset.atoolsSearchInput = "true"; document.body.append(input);
  back.focus();

  const open = observeLauncherReturnState(document);
  expect(open).toMatchObject({
    pluginPanelPresent: true, iframePresent: true, launcherInputPresent: true,
    launcherInputFocused: false, activeElementCategory: "plugin-panel-control",
  });
  expect(typeof open.documentHasFocus).toBe("boolean");
  expect(["visible", "hidden", "other"]).toContain(open.visibilityState);
  panel.remove();
  input.focus();
  const returned = observeLauncherReturnState(document);
  expect(returned).toMatchObject({
    pluginPanelPresent: false, iframePresent: false, launcherInputPresent: true,
    launcherInputFocused: true, activeElementCategory: "launcher-input",
  });
});

it("reports another focused input without retaining its value or DOM text", () => {
  const input = document.createElement("input"); input.value = "sensitive fixture text"; document.body.append(input); input.focus();
  const observation = observeLauncherReturnState(document);
  expect(observation).toMatchObject({
    pluginPanelPresent: false, iframePresent: false, launcherInputPresent: false,
    launcherInputFocused: false, activeElementCategory: "other-input",
  });
  expect(JSON.stringify(observation)).not.toContain("sensitive fixture text");
});
