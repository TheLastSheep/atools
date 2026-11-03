import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativePublishedRegexFrameOperations.js?raw";

type Adapter = { perform: (operation: string, data?: Record<string, unknown>) => Record<string, any> };
const owned = window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter; ztools?: any; utools?: any; require?: any; services?: any };
let adapter: Adapter, aliases: ReturnType<typeof vi.fn>[], write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Hand-authored host doubles only; no original plugin/preload, actual filesystem or GUI execution.
  aliases = Array.from({ length: 3 }, () => vi.fn(name => name === "downloads" ? "/synthetic/downloads" : ""));
  write = vi.fn(() => "/synthetic/downloads/123.txt");
  owned.ztools = { getPath: aliases[0] }; owned.utools = { getPath: aliases[1] };
  owned.require = vi.fn(name => { if (name !== "electron") throw Error("Unexpected module"); return { app: { getPath: aliases[2] } }; });
  owned.services = { writeTextFile: write, readFile: vi.fn(() => { throw Error("Unreviewed read"); }),
    writeImageFile: vi.fn(() => { throw Error("Unreviewed image"); }) };
  window.eval(source); adapter = owned.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
});
afterEach(() => {
  delete owned.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; delete owned.ztools; delete owned.utools;
  delete owned.require; delete owned.services;
});

it("observes all three synchronous aliases without returning actual path strings", () => {
  const originals = [owned.ztools.getPath, owned.utools.getPath, owned.require, owned.services.writeTextFile, Date.now];
  const result = adapter.perform("path-contract");
  expect(result.pathContract).toEqual({ downloadsType: "string", downloadsNonEmpty: true, allAliasesAgree: true,
    allReadsSynchronous: true, repeatedReadsPerAlias: 120, unknownZtoolsEmpty: true, unknownUtoolsEmpty: true,
    unknownElectronEmpty: true, actualPathValuesRecorded: false });
  expect(aliases.map(mock => mock.mock.calls.length)).toEqual([122, 121, 121]);
  expect(JSON.stringify(result)).not.toContain("/synthetic/downloads");
  expect([owned.ztools.getPath, owned.utools.getPath, owned.require, owned.services.writeTextFile, Date.now]).toEqual(originals);
  expect(write).not.toHaveBeenCalled(); expect(owned.services.readFile).not.toHaveBeenCalled();
});

it("exposes asynchronous or disagreeing APIs as failed observations, not invented synchronous values", () => {
  aliases[1].mockImplementation(() => "/different");
  expect(adapter.perform("path-contract").pathContract).toMatchObject({ allAliasesAgree: false, unknownUtoolsEmpty: false });
  aliases[1].mockImplementation(() => Promise.resolve("/synthetic/downloads"));
  expect(adapter.perform("path-contract").pathContract).toMatchObject({ allAliasesAgree: false, allReadsSynchronous: false });
  expect(write).not.toHaveBeenCalled();
});

it("invokes the existing service once with exact fixed UTF-8 text and never emits its returned path", () => {
  const result = adapter.perform("preload-write-synthetic-text");
  expect(write.mock.calls).toEqual([["ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n", ".txt"]]);
  expect(result).toEqual({ originalPreloadService: true, exportUiClicked: false, returnedString: true,
    returnedPathRecorded: false, fixedTextBytes: new TextEncoder().encode("ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n").length });
  expect(JSON.stringify(result)).not.toContain("/synthetic/downloads");
  expect(() => adapter.perform("preload-write-synthetic-text")).toThrow(/already attempted/);
  expect(write).toHaveBeenCalledOnce(); expect(owned.services.readFile).not.toHaveBeenCalled(); expect(owned.services.writeImageFile).not.toHaveBeenCalled();
});

it.each(["text", "path", "extension", "value"])("refuses caller-controlled export %s before invoking the original service", key => {
  expect(() => adapter.perform("preload-write-synthetic-text", { [key]: "arbitrary" })).toThrow(/does not accept/);
  expect(write).not.toHaveBeenCalled();
});

it("does not fabricate a successful service contract if the original method fails", () => {
  write.mockReturnValue(undefined);
  expect(adapter.perform("preload-write-synthetic-text").returnedString).toBe(false);
  expect(() => adapter.perform("preload-write-synthetic-text")).toThrow(/already attempted/);
});

it.each(["readFile", "writeImageFile", "export-ui-click", "arbitrary-file-write"])("does not expose the excluded operation %s", operation => {
  expect(() => adapter.perform(operation)).toThrow(/Unknown/); expect(write).not.toHaveBeenCalled();
});
