import { describe, expect, it } from "vitest";
import {
  createPluginApiStandinProbe,
  installWindowPluginApiStandinProbe,
  pluginApiStandinProbeScript,
} from "../../src/lib/pluginApiStandinProbe";
import {
  extractAtoolsHostApiSurface,
  evaluateSourceApiCompatibility,
} from "../../scripts/compare-host-api-surface.mjs";

describe("Plugin API Stand-in Probe (web_standin_show pattern)", () => {
  it("preserves reference identity and own properties while recording unknown API reads", () => {
    const probe = createPluginApiStandinProbe(8);
    const utoolsMock: Record<string, any> = {
      getAppName: () => "ATools",
      db: {
        get: (id: string) => ({ _id: id }),
      },
    };

    const observed = probe.observeObject("utools", utoolsMock, ["db"]);
    expect(observed).toBe(utoolsMock);
    expect(Object.keys(utoolsMock)).toEqual(["getAppName", "db"]);

    // Known property reads do not record unknown entries
    expect(utoolsMock.getAppName()).toBe("ATools");
    expect(utoolsMock.db.get("doc-1")).toEqual({ _id: "doc-1" });
    expect(utoolsMock.then).toBeUndefined();
    expect(utoolsMock.toJSON).toBeUndefined();
    expect(utoolsMock.__internalFlag).toBeUndefined();
    expect(probe.getReport()).toEqual({
      totalUnknownReads: 0,
      entries: [],
      overflowed: false,
    });

    // Unknown property reads return undefined honestly while recording into the ledger
    expect(utoolsMock.futureCloudSync).toBeUndefined();
    expect(utoolsMock.futureCloudSync).toBeUndefined();
    expect(utoolsMock.db.futureVectorSearch).toBeUndefined();

    expect(probe.getReport()).toEqual({
      totalUnknownReads: 3,
      entries: [
        { surface: "utools", property: "futureCloudSync", count: 2 },
        { surface: "utools.db", property: "futureVectorSearch", count: 1 },
      ],
      overflowed: false,
    });
  });

  it("caps unique ledger entries at maxEntries and marks overflowed", () => {
    const probe = createPluginApiStandinProbe(3);
    const target: Record<string, any> = {};
    probe.observeObject("electron", target);

    void target.missingA;
    void target.missingB;
    void target.missingC;
    void target.missingD;

    const report = probe.getReport();
    expect(report.totalUnknownReads).toBe(4);
    expect(report.entries).toHaveLength(3);
    expect(report.overflowed).toBe(true);

    probe.reset();
    expect(probe.getReport()).toEqual({
      totalUnknownReads: 0,
      entries: [],
      overflowed: false,
    });
  });

  it("installs on a window-like object and instruments utools, ztools, and electron", () => {
    const electronMock: Record<string, any> = {
      shell: { openExternal: () => true },
      clipboard: { readText: () => "" },
    };
    const fakeWindow: any = {
      utools: {
        hideMainWindow: () => true,
        db: { put: () => ({ ok: true }) },
      },
      ztools: {
        hideMainWindow: () => true,
      },
      require: (spec: string) => (spec === "electron" ? electronMock : undefined),
    };

    installWindowPluginApiStandinProbe(fakeWindow);
    expect(typeof fakeWindow.__atoolsGetApiStandinReport).toBe("function");
    expect(typeof fakeWindow.utools.__atoolsGetApiStandinReport).toBe("function");

    void fakeWindow.utools.hideMainWindow();
    void fakeWindow.utools.nonExistentUtoolsApi;
    void fakeWindow.ztools.nonExistentZtoolsApi;
    void electronMock.shell.nonExistentShellMethod;

    expect(fakeWindow.__atoolsGetApiStandinReport()).toEqual({
      totalUnknownReads: 3,
      entries: [
        { surface: "utools", property: "nonExistentUtoolsApi", count: 1 },
        { surface: "ztools", property: "nonExistentZtoolsApi", count: 1 },
        { surface: "electron.shell", property: "nonExistentShellMethod", count: 1 },
      ],
      overflowed: false,
    });
    expect(pluginApiStandinProbeScript()).toContain("data-atools-api-standin-probe");
  });
});

describe("Host API Surface & Coverage Comparator (js_exports_compare pattern)", () => {
  it("extracts ATools utools and electron host surfaces and evaluates plugin API coverage", () => {
    const surface = extractAtoolsHostApiSurface();
    expect(surface.utools).toContain("onPluginEnter");
    expect(surface.utools).toContain("desktopCaptureSources");
    expect(surface.utools).toContain("dbCryptoStorage");
    expect(surface.electron).toContain("desktopCapturer");
    expect(surface.electron).toContain("ipcRenderer");
    expect(surface.electron).toContain("safeStorage");

    const fullySupportedSample = `
      window.utools.onPluginEnter((action) => {
        const sources = utools.desktopCaptureSources({ types: ['screen'] });
        const { desktopCapturer, clipboard } = require('electron');
        electron.desktopCapturer.getSources({ types: ['window'] });
        electron.clipboard.writeText('ok');
      });
    `;
    const res1 = evaluateSourceApiCompatibility(fullySupportedSample, surface);
    expect(res1.coveragePercent).toBe(100);
    expect(res1.utools.missing).toEqual([]);
    expect(res1.electron.missing).toEqual([]);

    const partialSample = `
      utools.onPluginEnter(() => {});
      utools.experimentalQuantumTeleport();
      electron.experimentalHologram.render();
    `;
    const res2 = evaluateSourceApiCompatibility(partialSample, surface);
    expect(res2.utools.covered).toEqual(["onPluginEnter"]);
    expect(res2.utools.missing).toEqual(["experimentalQuantumTeleport"]);
    expect(res2.electron.missing).toEqual(["experimentalHologram"]);
    expect(res2.coveragePercent).toBeLessThan(100);
  });
});
