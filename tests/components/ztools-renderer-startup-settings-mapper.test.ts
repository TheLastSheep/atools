import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { parseSettingsJson } from "../../packages/ztools-renderer/src/mappers";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

function nativeSnapshot(generalRaw: string) {
  const settings: Record<string, string | null> = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
  );
  settings["settings-general"] = generalRaw;
  return { version: 1, settings };
}

describe("ZTools renderer startup General settings mapping", () => {
  it("keeps tabTargetCommand up to 2049 bytes and the legacy alias while filtering secrets", () => {
    const targetCommand = "x".repeat(2049);
    expect(new TextEncoder().encode(targetCommand).byteLength).toBe(2049);
    const otherSafe = {
      builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true },
      hotkey: "Ctrl+Space",
      appShortcuts: ["Example"],
      launchAtLogin: true,
      showTrayIcon: true,
      wakeupBlacklist: ["Example"],
      opacity: 0.9,
      windowMaterial: "mica",
      localAppSearch: true,
      localLaunchSearch: true,
      autoPaste: "off",
      autoBackToSearch: "never",
      pluginEscapeToSearch: true,
      windowDefaultHeight: 500,
      windowPositionStrategy: "remember",
      clipboardRetentionDays: 30,
      superPanelEnabled: false,
      floatingBallEnabled: false,
      devToolsMode: "right",
    };
    const eventPreferences = {
      placeholder: "Search",
      theme: "dark",
      primaryColor: "green",
      customColor: "#abcdef",
      autoClear: "1m",
      showRecentInSearch: true,
      recentRows: 3,
      pinnedRows: 2,
      searchMode: "aggregate",
      showMatchRecommendation: false,
      tabKeyFunction: "navigate",
      tabTargetCommand: targetCommand,
      spaceOpenCommand: true,
    };
    const expected = { ...eventPreferences, tabTarget: "legacy target", ...otherSafe };
    const parsed = parseSettingsJson(JSON.stringify({
      ...eventPreferences,
      tabTarget: "legacy target",
      ...otherSafe,
      aiApiKey: "secret-api-key",
      unknownPreference: "secret-unknown",
    }));

    expect(parsed).toEqual(expected);
    expect(JSON.stringify(parsed)).not.toContain("secret-api-key");
    expect(JSON.stringify(parsed)).not.toContain("secret-unknown");
  });

  it("preserves the exact field on a cold Native snapshot → startup read model → mapper read", async () => {
    const targetCommand = "x".repeat(2049);
    const raw = JSON.stringify({
      tabTargetCommand: targetCommand,
      tabTarget: "legacy target",
      aiApiKey: "secret-api-key",
      unknownPreference: "secret-unknown",
    });
    const transport: ZToolsRendererTransport = {
      invoke: vi.fn(async (command: RendererHostCommand) => {
        if (command !== "get_ztools_renderer_settings") throw new Error(`unexpected route: ${command}`);
        return nativeSnapshot(raw);
      }),
      async listen() {
        return () => undefined;
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });

    await expect(adapter.api.dbGet("settings-general")).resolves.toEqual({
      builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true },
      tabTargetCommand: targetCommand,
      tabTarget: "legacy target",
    });
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().settingsSnapshot).toMatchObject({ requests: 1, cached: NAMESPACED_READ_KEYS.size + 1 });
    expect(JSON.stringify(adapter.snapshot())).not.toContain("secret-api-key");
    expect(JSON.stringify(adapter.snapshot())).not.toContain("secret-unknown");
    adapter.dispose();
  });
});
