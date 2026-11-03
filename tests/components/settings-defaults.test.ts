import { afterEach, expect, it } from "vitest";
import {
  DEFAULT_ATOOLS_SETTINGS,
  loadAToolsSettingsSync,
  normalizeSettings,
  SETTINGS_STORAGE_KEY,
} from "../../src/lib/settings";

afterEach(() => localStorage.clear());

it("defaults a missing tray preference to visible and retains an explicit false", () => {
  expect(DEFAULT_ATOOLS_SETTINGS.showTrayIcon).toBe(true);
  expect(normalizeSettings({}).showTrayIcon).toBe(true);
  expect(normalizeSettings({ showTrayIcon: false }).showTrayIcon).toBe(false);
  expect(normalizeSettings({ showTrayIcon: null as unknown as boolean }).showTrayIcon).toBe(true);

  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: "dark" }));
  expect(loadAToolsSettingsSync().showTrayIcon).toBe(true);
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ showTrayIcon: false }));
  expect(loadAToolsSettingsSync().showTrayIcon).toBe(false);
});
