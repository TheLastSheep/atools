import { expect, it, vi } from "vitest";
import { activateFiles } from "./nativePublishedDeepReadScenario";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

const fixtureFile = { bytes: 4096, content: "fixed deterministic multipage text omitted",
  fileName: "ATools-DeepRead-Reader-Fixture.txt", path: "/private/tmp/atools-fixture-environment-test/home/Downloads/ATools-DeepRead-Reader-Fixture.txt",
  readOnly: true, sha256: "81f1d61593517a97f8f206e0df298e45bdabeaa99fc99d32009eb3b80c50ac83",
  storedContentBytes: 8854, storedContentSha256: "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0",
  title: "ATools DeepRead Reader Fixture" } as const;

it("records a safe missing-port observation and preserves the existing missing-port failure", async () => {
  const context = { observations: {} } as unknown as PublishedScenarioContext;
  await expect(activateFiles(context, fixtureFile)).rejects.toThrow("The smoke-gated production files-activation port is unavailable");
  expect(context.observations.deepReadFileActivationFailure).toMatchObject({
    phase: "deepread-original-fixed-file-import", command: "activate_file_content_feature",
    featureCode: "deepread-import", pluginId: "deepread", fileCount: 1,
    activationStage: "port-unavailable", errorCode: "FILES_PORT_MISSING"
  });
  expect(JSON.stringify(context.observations)).not.toContain(fixtureFile.path);
});

it("records only normalized rejection details and preserves the generic activation failure", async () => {
  const observations: Record<string, unknown> = {};
  const activate = vi.fn(async () => { throw new Error("Command activate_file_content_feature not found /Users/private token=fixture nonce=abc"); });
  const context = { observations, activateFilesFeature: activate } as unknown as PublishedScenarioContext;
  await expect(activateFiles(context, fixtureFile)).rejects.toThrow("The production DeepRead fixed-file activation failed");
  expect(activate).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith("deepread-import", [fixtureFile.path], "deepread");
  expect(observations.deepReadFileActivationFailure).toMatchObject({ activationStage: "callback-reported-error",
    errorKind: "error", errorName: "Error", errorCode: "COMMAND_NOT_FOUND" });
  const serialized = JSON.stringify(observations);
  expect(serialized).not.toContain(fixtureFile.path);
  expect(serialized).not.toMatch(/Users\/private|fixture nonce|token=|stack/);
});
