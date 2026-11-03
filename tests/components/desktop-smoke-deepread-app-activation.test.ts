import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({ default: (await import("./PluginLifecyclePanelFixture.svelte")).default }));

type FilesActivation = (code: string, paths: readonly [string], expectedPluginId: string) => Promise<void>;
const fixturePath = "/private/tmp/atools-fixture-environment-run-1/home/Downloads/ATools-DeepRead-Reader-Fixture.txt";
const activation = { plugin_id: "deepread", plugin_name: "DeepRead", feature_code: "deepread-import",
  main_url: "index.html", plugin_path: "/isolated/deepread", expand_height: 400, payload: null };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  mocks.invoke.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("forwards the gated App port through normal file activation and revokes it on teardown", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "true");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false }));
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_setting") return JSON.stringify({ autoPaste: "never", localAppSearch: false });
    if (command === "feature_catalog" || command === "search_features"
      || command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    if (command === "activate_file_content_feature") return activation;
    return undefined;
  });

  let published: FilesActivation | undefined;
  const view = render(App, { backgroundServices: false, onDesktopSmokeFilesActivationReady: activate => {
    published = activate;
  } });
  expect(published).toBeTypeOf("function");
  const activate = published;
  if (!activate) throw new Error("App did not publish the gated DeepRead activation port");

  await activate("deepread-import", [fixturePath], "deepread");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_file_content_feature", {
    code: "deepread-import", paths: [fixturePath], expectedPluginId: "deepread",
  }));

  view.unmount();
  await expect(activate("deepread-import", [fixturePath], "deepread"))
    .rejects.toThrow("scope is unavailable");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_file_content_feature")).toHaveLength(1);
});
