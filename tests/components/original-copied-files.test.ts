import { describe, expect, it } from "vitest";
import {
  copiedFilePath, originalCopiedFilesHost, originalImageStitch, originalImgbatchSnapshot, originalQuickCommandFiles,
  type CopiedEntry,
} from "./originalCopiedFilesFixture";

const copied = (path: string, isFile = true): CopiedEntry => ({
  name: "空 格\n🧰.png", path, isFile, isDirectory: !isFile, isDiractory: !isFile,
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("original synchronous copied-file consumers through production bridge serialization", () => {
  it("feeds the exact Imgbatch snapshot functions fresh canonical entries without trimming or splitting paths", async () => {
    const updatedPath = "C:\\Users\\QA User\\updated\n第二张.png";
    const host = await originalCopiedFilesHost({ responses: [[copied(copiedFilePath)], [copied(copiedFilePath)], [copied(updatedPath)], [copied(copiedFilePath)]] });
    const result = host.api.getCopyedFiles();
    expect(Array.isArray(result)).toBe(true);
    expect((result as any).then).toBeUndefined();
    expect(result).toEqual([copied(copiedFilePath)]);
    const snapshot = await originalImgbatchSnapshot(host.api);
    expect(snapshot.paths).toEqual([copiedFilePath]);
    expect(snapshot.value).toEqual([copied(copiedFilePath)]);
    expect(snapshot.signature).toBe(copiedFilePath);
    expect(host.api.getCopiedFiles()[0].path).toBe(updatedPath);
    expect(host.api.getCopyedFiles()[0].path).toBe(copiedFilePath);
    expect(host.calls.every(call => call.async === false && call.payload.format === "files")).toBe(true);
    expect(snapshot.pin).toEqual({ path: "ZTools-plugins/plugins/imgbatch/preload.js", sha256: "d8ca3f4614c5ad336a1a6b7e667bf11fbb2499189a6ab546b71b740504123867" });
    expect(snapshot.manifest.declaredPlatforms).toEqual(["win32"]);
  });

  it("lets the exact QuickCommand callback restore the original copied-file object array", async () => {
    const original = [copied(copiedFilePath)], selected = [copied("C:\\Users\\QA User\\selected file\n第二张.png")];
    const host = await originalCopiedFilesHost({ responses: [original, selected] });
    const run = await originalQuickCommandFiles(host.api);
    expect(run.observed.hideCalls).toBe(1);
    expect(run.observed.simulated).toEqual([["c", "control"]]);
    expect(run.observed.timers).toHaveLength(1);
    run.observed.timers[0]();
    expect(plain(await run.result)).toEqual(selected);
    expect(run.observed.restored).toHaveLength(1);
    expect(plain(run.observed.restored[0])).toEqual(original);
    expect(host.calls).toHaveLength(2);
    expect(host.calls.every(call => call.async === false && call.payload.format === "files")).toBe(true);
    expect(run.pin).toEqual({ path: "ZTools-plugins/plugins/quickcommand/plugin/lib/quickcomposer/status/getSelected.js", sha256: "506a0e7a427e2257d73eb0cec6f64ea013a1b152c80e1c6834f4c651468fd3fd" });
  });

  it("keeps image-stitch's original object-as-string defect visible", async () => {
    const host = await originalCopiedFilesHost({ responses: [[copied(copiedFilePath)]] });
    const result = await originalImageStitch(host.api);
    expect(result.fallbackReads).toBe(0);
    expect(result.added).toEqual([]);
    expect(host.calls).toHaveLength(1);
    expect(result.pin).toEqual({ path: "ZTools-plugins/plugins/image-stitch/app.js", sha256: "37105dde6dad683d2c4b211ccf51392f5f148c6c8bb02e20c3a264464133384c" });
  });

  it("throws for an ungranted read and never replays that first call after permission arrives", async () => {
    const host = await originalCopiedFilesHost({ endpoints: false, responses: [[copied(copiedFilePath)]] });
    expect(() => host.api.getCopyedFiles()).toThrow("PERMISSION_REQUIRED");
    expect(host.calls).toEqual([]);
    expect(host.posts.filter(message => message?.__atools_host_clipboard_open__)).toHaveLength(1);
    host.deliver({ __atools_host_clipboard_session__: true, instanceId: "original-copied-files-instance", access: "read", endpoint: host.endpoint });
    expect(host.calls).toEqual([]);
    expect(host.api.getCopyedFiles()).toEqual([copied(copiedFilePath)]);
    expect(host.calls).toHaveLength(1);
  });
});
