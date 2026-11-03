import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { pluginSourceBuildServices } from "../../src/lib/pluginSourceBuildServices";

it("starts only the shared unconfirmed capability pipeline with exact preflight identity", async () => {
  const service = pluginSourceBuildServices(async () => {});
  await service.start("/synthetic/source", "a".repeat(64));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("start_agent_tool", {
    name: "convert_ztools_plugin", arguments: { sourcePath: "/synthetic/source", expectedRevision: "a".repeat(64), overwrite: true },
    clientId: "atools-ui", confirmed: false,
  });
});

it("uses native preflight, authoritative run, stage and cancellation commands", async () => {
  mocks.invoke.mockClear();
  const service = pluginSourceBuildServices(async () => {});
  await service.inspect("/synthetic/source", "public"); await service.inspect("/synthetic/legacy");
  await service.start("/synthetic/source", "a".repeat(64), "public", "b".repeat(64));
  await expect(service.start("/synthetic/source", "a".repeat(64), "root")).rejects.toThrow("必须同时提供");
  await service.read("run"); await service.runtime("run"); await service.cancel("run");
  expect(mocks.invoke.mock.calls).toEqual([
    ["start_agent_tool", { name: "inspect_ztools_source_build", arguments: { sourcePath: "/synthetic/source", manifestSelection: "public" }, clientId: "atools-ui", confirmed: false }],
    ["start_agent_tool", { name: "inspect_ztools_source_build", arguments: { sourcePath: "/synthetic/legacy" }, clientId: "atools-ui", confirmed: false }],
    ["start_agent_tool", { name: "convert_ztools_plugin", arguments: { sourcePath: "/synthetic/source", expectedRevision: "a".repeat(64), overwrite: true, manifestSelection: "public", expectedManifestSha256: "b".repeat(64) }, clientId: "atools-ui", confirmed: false }],
    ["get_task_run", { id: "run" }], ["get_plugin_source_build_state", { id: "run" }], ["cancel_task_run", { id: "run" }],
  ]);
});
