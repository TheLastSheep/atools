import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { invoke, launcherInput, permissionDialog } from "./nativePublishedPluginCommon";
import type { RuntimeState } from "./nativePublishedPluginCommon";

type ColorState = {
  colorPage: boolean; hex: string; rgb: string; hsl: string; background: string;
  collectionPage: boolean; collectionRows: string[]; dialogOpen: boolean; dialogError: string;
  gradientPage: boolean; gradientRows: number; gradientBackground: string;
};
const compact = (value: string) => value.replace(/\s+/g, "").toLowerCase();

export async function runPublishedBusinessScenario(context: PublishedScenarioContext) {
  const { probe, until, check, setPhase, observations } = context;
  const state = () => probe<ColorState>("state");
  const wait = (accept: (value: ColorState) => boolean, label: string) => until(async () => {
    const value = await state(); return accept(value) ? value : null;
  }, label);
  setPhase("color-helper-red-conversion");
  await wait(value => value.colorPage, "Original published color page did not mount");
  await probe("set-color", { model: "hex", value: "ff0000" });
  const red = await wait(value => compact(value.rgb) === "255,0,0", "Original HEX red did not update RGB");
  check(compact(red.hex) === "ff0000" && compact(red.background) === "rgb(255,0,0)",
    "Original published HEX input synchronizes red RGB fields and preview");
  observations.colorRed = red;
  setPhase("color-helper-invalid-recovery");
  await probe("set-color", { model: "hex", value: "not-a-color" });
  const invalid = await wait(value => value.hex === "not-a-color", "Invalid HEX raw input did not remain editable");
  check(compact(invalid.rgb) === "255,0,0", "Invalid HEX retains the last valid converted color");
  await probe("set-color", { model: "hex", value: "00ff00" });
  const green = await wait(value => compact(value.rgb) === "0,255,0", "Valid green did not recover conversion");
  check(compact(green.background) === "rgb(0,255,0)", "Valid HEX restores synchronized green preview after invalid input");
  observations.colorInvalidAndRecovery = { invalid, green };
  setPhase("color-helper-collection-dialog");
  await probe("navigate", { page: "collect" });
  await wait(value => value.collectionPage, "Original collection page did not mount");
  await probe("new-collection");
  await wait(value => value.dialogOpen, "Original collection dialog did not open");
  await probe("set-collection-name", { value: "ATools reviewed red" });
  await probe("set-collection-color", { value: "invalid-color" });
  await probe("confirm-collection");
  const rejected = await wait(value => value.dialogError.includes("错误的色值"), "Original collection did not reject invalid color");
  check(rejected.dialogOpen && rejected.collectionRows.length === 0,
    "Original collection dialog rejects an invalid color without adding a row");
  await probe("set-collection-color", { value: "#ff0000" });
  await probe("confirm-collection");
  const saved = await wait(value => !value.dialogOpen && value.collectionRows.some(row =>
    row.includes("ATools reviewed red") && row.includes("#FF0000")), "Original collection did not save named red");
  check(saved.collectionRows.length === 1, "Original collection UI displays exactly one named color after confirmation");
  await probe("navigate", { page: "color" });
  await wait(value => value.colorPage, "Color page did not return after collection save");
  await probe("navigate", { page: "collect" });
  const restored = await wait(value => value.collectionRows.some(row => row.includes("ATools reviewed red")),
    "Original collection did not reload its saved row after page remount");
  check(restored.collectionRows.length === 1, "Original collection reloads its named color on page remount");
  const database = await until(async () => {
    const snapshot = await invoke<{ pluginId: string; documentId: string;
      document: { _id: string; _rev: string; name: string; color: string } | null;
      storage: { key: string; value: unknown }; source: string; readOnly: boolean }>("native_published_data_snapshot");
    return snapshot.document?.name === "ATools reviewed red" && snapshot.document.color === "#FF0000"
      && Array.isArray(snapshot.storage.value) && snapshot.storage.value.includes("color/ff0000") ? snapshot : null;
  }, "Original collection did not persist the named color and sort order in the isolated SQLite database");
  check(database.pluginId === "color-helper" && database.documentId === "color/ff0000"
    && database.document?._id === "color/ff0000" && typeof database.document?._rev === "string"
    && database.document._rev.length > 0 && database.storage.key === "collectsort" && database.readOnly === true,
    "Independent read-only host snapshot proves the original collection document and sort order reached plugin-scoped SQLite");
  observations.colorCollection = { saved, restored, database };
  setPhase("color-helper-original-lazy-gradient");
  await probe("navigate", { page: "gradient" });
  const gradients = await wait(value => value.gradientPage && value.gradientRows > 0,
    "Original lazy gradient module did not render its palette");
  check(gradients.gradientBackground.includes("linear-gradient"), "Original lazy gradient page renders a real CSS gradient");
  observations.colorGradients = { rows: gradients.gradientRows, background: gradients.gradientBackground };
  return { businessOutcome: "scoped_pass", tested: ["HEX/RGB/preview conversion", "invalid color recovery",
    "collection validation and database page-remount persistence", "original lazy gradient module rendering"],
  notTested: ["copy/clipboard", "screen capture/picker", "image input/export", "AI", "save dialogs/filesystem",
    "physical keyboard/pointer", "complete color-space numeric accuracy"] };
}

/** Re-enter through the launcher; no plugin storage or UI state is injected. */
export async function verifyColorCollectionAfterReopen(context: PublishedScenarioContext) {
  const { until, check, profile, probe, observations, setPhase } = context;
  setPhase("color-helper-whole-plugin-reopen");
  const input = launcherInput(); check(input, "Launcher is available before full color plugin reopen");
  input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode),
    "Color catalog feature did not return after close");
  observations.colorReopenCatalog = { title: option.querySelector(".result-title")?.textContent, selection: "actual catalog row click" };
  option.click();
  for (const title of ["请求访问自己的数据", "请求访问本机"]) {
    await until(() => permissionDialog()?.querySelector("h2")?.textContent?.includes(title), "Reopened color plugin did not request fresh one-time permission: " + title);
    const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")]
      .find(node => node.textContent?.trim() === "允许一次");
    check(allow, "Reopened color plugin requires explicit fresh approval: " + title); allow!.click();
    await until(() => !permissionDialog()?.querySelector("h2")?.textContent?.includes(title), "Fresh color approval did not finish");
  }
  await until(() => document.querySelector('iframe[title="Plugin"]'), "Color plugin did not reopen its actual frame");
  await until(async () => (await probe<ColorState>("state")).colorPage, "Reopened original color page did not mount");
  await probe("navigate", { page: "collect" });
  const restored = await until(async () => {
    const value = await probe<ColorState>("state");
    return value.collectionPage && value.collectionRows.some(row => row.includes("ATools reviewed red") && row.includes("#FF0000")) ? value : null;
  }, "Original named color disappeared after whole-plugin close and fresh authorization");
  check(restored.collectionRows.length === 1, "Named color survives whole-plugin close, fresh authorization and new iframe");
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(runtime.dataSessions === 1 && runtime.dataTransport && runtime.legacySessions === 1,
    "Reopened original color frame owns only one fresh data session and Node session");
  observations.colorCollectionAfterWholeReopen = { restored, runtime, freshOneTimeApprovals: 2, documentsInjected: false };
}
