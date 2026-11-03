import { afterEach, expect, it, vi } from "vitest";
import { createLauncherDesktopSmokeHost } from "../../src/lib/launcherDesktopSmokeHost";
import type { DesktopSmokeDeepReadFilesActivation } from "../../src/lib/desktopSmokeDeepReadFilesActivationPort";

const imageFixtureInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: imageFixtureInvoke }));

const FIXTURE_PATH = "/private/tmp/atools-fixture-environment-test/home/Downloads/ATools-DeepRead-Reader-Fixture.txt";
const IMAGE_TOP = "/private/tmp/atools-fixture-environment-test/home/Downloads/atools-image-stitch-top.png";
const IMAGE_BOTTOM = "/private/tmp/atools-fixture-environment-test/home/Downloads/atools-image-stitch-bottom.png";
const IMAGE_RUN_ID = "b67f93ba-7420-4c2f-8b35-67dcde4d43a2";
const imageFixture = {
  caseId: "local-image-stitch-head", pluginId: "image-stitch", featureCode: "image-stitch-files", runId: IMAGE_RUN_ID,
  orderedPaths: [IMAGE_TOP, IMAGE_BOTTOM], pathAccess: "none", totalBytes: 72,
  files: [
    { path: IMAGE_TOP, fileName: "atools-image-stitch-top.png", sha256: "a".repeat(64), bytes: 36, width: 2, height: 2 },
    { path: IMAGE_BOTTOM, fileName: "atools-image-stitch-bottom.png", sha256: "b".repeat(64), bytes: 36, width: 2, height: 2 },
  ],
};

function createHost() {
  const onReady = vi.fn<(activate: DesktopSmokeDeepReadFilesActivation) => void>();
  const activateFeature = vi.fn(async () => 17);
  const host = createLauncherDesktopSmokeHost({
    state: { activePlugin: null, desktopSmokePluginActions: [], desktopSmokePluginIndex: 0,
      activePanel: "home", query: "", results: [], selectedIndex: 0 },
    hasTauriRuntime: () => false,
    waitForTauriRuntime: async () => false,
    sleep: async () => {},
    activateFeature,
    onDesktopSmokeFilesActivationReady: onReady,
    resizePalette: async () => {},
    returnPluginToSearch: async () => {},
    openSettingsMenu: async () => {},
    onPanelChange: async () => {}
  });
  return { host, onReady, activateFeature };
}

afterEach(() => { vi.unstubAllEnvs(); imageFixtureInvoke.mockReset(); });

it("keeps both smoke gates closed by default", () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "false");
  const { host, onReady } = createHost();
  expect(host.enabled()).toBe(false);
  expect(onReady).not.toHaveBeenCalled();
  host.dispose();
});

it("opens only the exact DeepRead files port under its dedicated gate", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "true");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "false");
  const { host, onReady, activateFeature } = createHost();
  expect(host.enabled()).toBe(false);
  expect(onReady).toHaveBeenCalledOnce();
  const activate = onReady.mock.calls[0]?.[0];
  expect(activate).toBeTypeOf("function");

  await activate!("deepread-import", [FIXTURE_PATH], "deepread");
  expect(activateFeature).toHaveBeenCalledOnce();
  expect(activateFeature).toHaveBeenCalledWith("deepread-import", null, expect.objectContaining({
    expectedPluginId: "deepread", mediaContent: { kind: "files", paths: [FIXTURE_PATH] }, throwOnError: true,
    isCancelled: expect.any(Function)
  }));
  host.dispose();
  await expect(activate!("deepread-import", [FIXTURE_PATH], "deepread")).rejects.toThrow();
  expect(activateFeature).toHaveBeenCalledOnce();
});

it("dispatches the exact Image Stitch tuple only under the full smoke gate and reads run-bound host evidence", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "true");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "false");
  imageFixtureInvoke.mockResolvedValue(imageFixture);
  const { host, onReady, activateFeature } = createHost();
  const activate = onReady.mock.calls[0]?.[0];
  expect(activate).toBeDefined();

  await activate!("image-stitch-files", [IMAGE_TOP, IMAGE_BOTTOM], "image-stitch", IMAGE_RUN_ID);
  expect(imageFixtureInvoke).toHaveBeenCalledOnce();
  expect(imageFixtureInvoke).toHaveBeenCalledWith("native_published_image_stitch_fixture");
  expect(activateFeature).toHaveBeenCalledOnce();
  expect(activateFeature).toHaveBeenCalledWith("image-stitch-files", null, expect.objectContaining({
    expectedPluginId: "image-stitch", mediaContent: { kind: "files", paths: [IMAGE_TOP, IMAGE_BOTTOM] },
    throwOnError: true, isCancelled: expect.any(Function),
  }));
  await expect(activate!("image-stitch-files", [IMAGE_TOP, IMAGE_BOTTOM], "image-stitch", IMAGE_RUN_ID)).rejects.toThrow("single-use");
  expect(imageFixtureInvoke).toHaveBeenCalledOnce();
  host.dispose();
});

it("opens the exact Image Stitch route under its dedicated gate without enabling general smoke or DeepRead", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "true");
  imageFixtureInvoke.mockResolvedValue(imageFixture);
  const { host, onReady, activateFeature } = createHost();
  const activate = onReady.mock.calls[0]?.[0];
  expect(activate).toBeDefined();
  expect(host.enabled()).toBe(false);

  await activate!("image-stitch-files", [IMAGE_TOP, IMAGE_BOTTOM], "image-stitch", IMAGE_RUN_ID);
  expect(imageFixtureInvoke).toHaveBeenCalledOnce();
  expect(activateFeature).toHaveBeenCalledOnce();
  await expect(activate!("deepread-import", [FIXTURE_PATH], "deepread")).rejects.toThrow();
  expect(activateFeature).toHaveBeenCalledOnce();
  host.dispose();
});

it("does not let the DeepRead-only opt-in activate the Image Stitch route", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "true");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "false");
  imageFixtureInvoke.mockResolvedValue(imageFixture);
  const { host, onReady, activateFeature } = createHost();
  const activate = onReady.mock.calls[0]?.[0];
  await expect(activate!("image-stitch-files", [IMAGE_TOP, IMAGE_BOTTOM], "image-stitch", IMAGE_RUN_ID)).rejects.toThrow("scope is unavailable");
  expect(imageFixtureInvoke).not.toHaveBeenCalled();
  expect(activateFeature).not.toHaveBeenCalled();
  host.dispose();
});

it("does not let the Image Stitch-only opt-in activate DeepRead", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "true");
  const { host, onReady, activateFeature } = createHost();
  const activate = onReady.mock.calls[0]?.[0];
  await expect(activate!("deepread-import", [FIXTURE_PATH], "deepread")).rejects.toThrow();
  expect(imageFixtureInvoke).not.toHaveBeenCalled();
  expect(activateFeature).not.toHaveBeenCalled();
  host.dispose();
});

it("rejects other features and paths before reaching the activation API", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "true");
  const { host, onReady, activateFeature } = createHost();
  const activate = onReady.mock.calls[0]?.[0];
  expect(activate).toBeDefined();
  await expect(activate!("deepread-next-page", [FIXTURE_PATH], "deepread")).rejects.toThrow();
  await expect(activate!("deepread-import", [FIXTURE_PATH], "other-plugin")).rejects.toThrow();
  await expect(activate!("deepread-import", ["/Users/example/book.txt"], "deepread")).rejects.toThrow();
  expect(activateFeature).not.toHaveBeenCalled();
  host.dispose();
});

it("preserves the existing general smoke gate without letting the dedicated gate set it", () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "yes");
  vi.stubEnv("VITE_ATOOLS_DEEPREAD_FILES_SMOKE", "false");
  vi.stubEnv("VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE", "false");
  const { host, onReady } = createHost();
  expect(host.enabled()).toBe(true);
  expect(onReady).toHaveBeenCalledOnce();
  host.dispose();
});
