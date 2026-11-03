import { expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach } from "vitest";
import ZToolsSourceBuildStatus from "../../src/components/ZToolsSourceBuildStatus.svelte";
import { sourceBuildPermissionPresentation } from "../../src/lib/pluginSourceBuildPermissions";
import type { PendingAgentToolRequest } from "../../src/lib/types";
import { validSourceBuildInspection } from "../../src/lib/pluginSourceBuildProtocol";

afterEach(() => cleanup());

it("renders an eligible inspection plan in order without revealing a script path", () => {
  render(ZToolsSourceBuildStatus, {
    entry: {
      phase: "eligible",
      inspection: {
        status: "eligible", pluginId: "fixture", version: "1.0", blockers: [], sourceRevision: "a".repeat(64),
        buildSteps: [
          { kind: "typecheck" },
          { kind: "nodeTests", files: 2 },
          { kind: "viteBuild" },
          { kind: "packageScript" },
        ],
      },
      message: "", observationError: "",
    },
    oninspect() {}, onconvert() {}, oncancel() {}, onresume() {}, onrescan() {},
  });
  const plan = screen.getByRole("region", { name: "所选项目的检查步骤" });
  expect([...plan.querySelectorAll("li")].map(item => item.textContent)).toEqual([
    "类型检查", "Node 测试（2 个文件）", "Vite 打包", "本地项目构建脚本",
  ]);
  expect(plan.textContent).not.toContain("scriptPath");
});

it("describes possible permission categories without inventing this project's exact plan", () => {
  const presentation = sourceBuildPermissionPresentation({
    id: "permit", run_id: "run", client_id: "atools-ui", tool_name: "convert_ztools_plugin",
    arguments: { sourcePath: "/fixture", expectedRevision: "a".repeat(64), overwrite: false },
    scopes: ["file_read", "file_write", "shell"], created_at: "2026-10-19T00:00:00Z",
  } as PendingAgentToolRequest);
  expect(presentation?.riskHints).toContain(
    "可能包含类型检查、测试、打包和本地构建脚本；实际顺序见所选项目的检查步骤。",
  );
});


it("keeps the same verified plan visible through the active conversion phases", async () => {
  const inspection = {
    status: "eligible" as const, pluginId: "fixture", version: "1.0", blockers: [], sourceRevision: "a".repeat(64),
    buildSteps: [{ kind: "typecheck" as const }, { kind: "nodeTests" as const, files: 2 }, { kind: "viteBuild" as const }],
  };
  const entry = { phase: "eligible" as const, inspection, message: "", observationError: "" };
  const view = render(ZToolsSourceBuildStatus, {
    entry, oninspect() {}, onconvert() {}, oncancel() {}, onresume() {}, onrescan() {},
  });
  const expected = ["类型检查", "Node 测试（2 个文件）", "Vite 打包"];
  for (const phase of ["eligible", "starting", "awaiting_permission", "preparing", "building", "installing", "cancelling"] as const) {
    await view.rerender({ entry: { ...entry, phase }, oninspect() {}, onconvert() {}, oncancel() {}, onresume() {}, onrescan() {} });
    const plan = screen.getByRole("region", { name: "所选项目的检查步骤" });
    expect([...plan.querySelectorAll("li")].map(item => item.textContent)).toEqual(expected);
  }
  for (const phase of ["checking", "failed", "cancelled", "succeeded"] as const) {
    await view.rerender({ entry: { ...entry, phase }, oninspect() {}, onconvert() {}, oncancel() {}, onresume() {}, onrescan() {} });
    expect(screen.queryByRole("region", { name: "所选项目的检查步骤" })).toBeNull();
  }
});

it("accepts legacy plans without steps, but validates complete eligible plans and their aggregate test budget", () => {
  const base = { status: "eligible" as const, pluginId: "fixture", version: "1.0", blockers: [], sourceRevision: "a".repeat(64) };
  expect(validSourceBuildInspection(base)).toBe(true);
  expect(validSourceBuildInspection({ ...base, buildSteps: [{ kind: "typecheck" }, { kind: "viteBuild" }] })).toBe(true);
  expect(validSourceBuildInspection({ ...base, buildSteps: [{ kind: "typecheck" }] })).toBe(false);
  expect(validSourceBuildInspection({ ...base, buildSteps: [{ kind: "viteBuild" }, { kind: "viteBuild" }] })).toBe(false);
  expect(validSourceBuildInspection({ ...base, buildSteps: [
    { kind: "nodeTests", files: 64 }, { kind: "nodeTests", files: 65 }, { kind: "viteBuild" },
  ] })).toBe(false);
  expect(validSourceBuildInspection({ ...base, buildSteps: [
    { kind: "nodeTests", files: 64 }, { kind: "nodeTests", files: 64 }, { kind: "viteBuild" },
  ] })).toBe(true);
});
