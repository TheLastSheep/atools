import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ZToolsImportPanel from "../../src/components/ZToolsImportPanel.svelte";
import ZToolsSourceBuildStatus from "../../src/components/ZToolsSourceBuildStatus.svelte";
import type { InstalledPlugin, TaskRun, ZToolsImportCandidate } from "../../src/lib/types";
import type { SourceBuildInspection } from "../../src/lib/pluginSourceBuildProtocol";
import type { ManifestCandidate, ManifestDifference, ManifestIdentity } from "../../src/lib/pluginSourceBuildManifest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const path = "/synthetic/source-plugin";
const revision = "a".repeat(64);
const candidate: ZToolsImportCandidate = {
  path, source_type: "directory", entry_readiness: "requires_build", name: "source-plugin", title: "源码插件", version: "1.0.0", features_count: 1,
  platform_supported: true, main_exists: false, preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [],
};
const plugin: InstalledPlugin = {
  id: "source-plugin", name: "源码插件", version: "1.0.0", enabled: true, path: "/synthetic/installed",
  created_at: "2026-10-19", updated_at: "2026-10-19", manifest: { title: "已转换插件", main: "index.html", features: [{ code: "main" }] },
};
const inspectionOutput = (selection?: "root" | "public", conflicting = false): SourceBuildInspection => {
  if (selection === undefined && !conflicting) return { status: "eligible", pluginId: plugin.id, version: "1.0.0", blockers: [], sourceRevision: revision };
  const rootIdentity: ManifestIdentity = { id: plugin.id, version: "1.0.0", main: "index.html", preload: null, runtime: "web", featureCodes: ["main"] };
  const publicIdentity: ManifestIdentity = conflicting ? { ...rootIdentity, version: "2.0.0" } : rootIdentity;
  const candidates: [ManifestCandidate, ManifestCandidate] = [
    { selection: "root", status: "valid", manifestSha256: "b".repeat(64), identity: rootIdentity },
    { selection: "public", status: "valid", manifestSha256: "c".repeat(64), identity: publicIdentity },
  ];
  const chosenSelection = selection === "public" ? "public" : "root";
  const chosenIdentity = chosenSelection === "public" ? publicIdentity : rootIdentity;
  const differences: ManifestDifference[] = conflicting ? ["version"] : [];
  return { status: "eligible", pluginId: chosenIdentity.id, version: chosenIdentity.version, blockers: [], sourceRevision: revision,
    manifestSelection: chosenSelection, manifestSha256: chosenSelection === "public" ? "c".repeat(64) : "b".repeat(64), manifestIdentity: chosenIdentity,
    manifestCandidates: candidates, manifestDifferences: differences };
};
const inspectionTask = (args: Record<string, unknown> = {}, output: SourceBuildInspection = inspectionOutput(args.manifestSelection as "root" | "public" | undefined)): TaskRun => ({
  id: "source-inspection-run", capabilityId: "inspect_ztools_source_build", initiator: { type: "human", clientId: "atools-ui" },
  input: args, status: "succeeded", output,
} as TaskRun);
const task = (status: TaskRun["status"], args?: Record<string, unknown>): TaskRun => ({
  id: "source-build-run", capabilityId: "convert_ztools_plugin", initiator: { type: "human", clientId: "atools-ui" },
  input: { sourcePath: path, expectedRevision: revision, overwrite: true, ...(args ?? {}) }, status,
  output: status === "succeeded" ? { pluginId: plugin.id, version: plugin.version, installed: true, sourceRevision: revision } : null,
} as TaskRun);
let status: TaskRun["status"];
let conversionInput: Record<string, unknown>;
let emit: (event: { payload: string }) => void;
let stop: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = "awaiting_permission"; conversionInput = {}; emit = () => {}; stop = vi.fn();
  mocks.invoke.mockReset(); mocks.open.mockReset(); mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (_event, callback) => { emit = callback; return stop; });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return inspectionTask(args.arguments as Record<string, unknown>);
    if (command === "start_agent_tool") { conversionInput = args?.arguments as Record<string, unknown>; return task("succeeded", conversionInput); }
    if (command === "get_task_run") return task(status, conversionInput);
    if (command === "get_plugin_source_build_state") return { active: status === "running", stage: "building", cancellable: status === "running", cancelRequested: false };
    if (command === "list_plugins") return [plugin];
    return undefined;
  });
});
afterEach(() => cleanup());

it.each(["requires_build", "incomplete"])("provides a user-triggered check for %s and waits for verified installation", async readiness => {
  const base = mocks.invoke.getMockImplementation()!;
  // Even an incomplete DTO without diagnostic text must stay out of direct import.
  mocks.invoke.mockImplementation(async (command, ...args) => command === "scan_default_ztools_plugins"
    ? [{ ...candidate, entry_readiness: readiness }] : base(command, ...args));
  render(ZToolsImportPanel);
  const check = await screen.findByRole("button", { name: /^检查可转换版本$/ });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "inspect_ztools_source_build")).toHaveLength(0);
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  expect(check.closest("label")).toBeNull();
  check.focus(); expect(document.activeElement).toBe(check);
  await fireEvent.click(check);
  await fireEvent.click(await screen.findByRole("button", { name: "一键转换并安装" }));
  await screen.findByText("等待你在授权弹窗中允许构建与安装。");
  expect(screen.queryByRole("button", { name: /^立即打开$/ })).toBeNull();
  expect(mocks.invoke.mock.calls.find(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin")?.[1]).toEqual({
    name: "convert_ztools_plugin", arguments: { sourcePath: path, expectedRevision: revision, overwrite: true }, clientId: "atools-ui", confirmed: false,
  });
  status = "succeeded"; emit({ payload: "source-build-run" });
  await screen.findByRole("button", { name: /^立即打开$/ });
  expect(screen.getByText("已转换插件")).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "import_ztools_plugins")).toHaveLength(0);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_plugins")).toHaveLength(1);
  expect(stop).toHaveBeenCalledTimes(1);
});

it("shows concrete local blockers without offering import or conversion, then allows reinspection", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  let checks = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build" && ++checks === 1) return inspectionTask(args.arguments as Record<string, unknown>, {
      status: "blocked", blockers: [{ code: "MISSING_DEPENDENCIES", message: "缺少本地 vite 依赖，请先准备插件依赖。" }], sourceRevision: revision,
    });
    return base(command, args);
  });
  render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: /^检查可转换版本$/ }));
  await screen.findByText("缺少本地 vite 依赖，请先准备插件依赖。");
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
  expect((screen.getByRole("button", { name: "导入 0 个插件" }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "重新检查转换" }));
  await screen.findByRole("button", { name: "一键转换并安装" });
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin")).toHaveLength(0);
});

it("returns already-ready sources to the existing scan and direct-import selection flow", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return inspectionTask(args.arguments as Record<string, unknown>, {
      status: "already_ready", pluginId: plugin.id, version: plugin.version, blockers: [], sourceRevision: revision,
    });
    if (command === "scan_ztools_plugins") return [{ ...candidate, entry_readiness: "ready", main_exists: true }];
    return base(command, args);
  });
  render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: /^检查可转换版本$/ }));
  await fireEvent.click(await screen.findByRole("button", { name: "重新扫描发布目录" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "导入 1 个插件" }) as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.invoke.mock.calls.find(([command]) => command === "scan_ztools_plugins")?.[1]).toEqual({ root: path });
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin")).toHaveLength(0);
});

it("unmounts task observation without silently cancelling the background conversion", async () => {
  const view = render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: /^检查可转换版本$/ }));
  await fireEvent.click(await screen.findByRole("button", { name: "一键转换并安装" }));
  await screen.findByText("等待你在授权弹窗中允许构建与安装。");
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(0);
  status = "succeeded"; emit({ payload: "source-build-run" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_plugins")).toHaveLength(0);
});

it("shows a non-cancellable install stage with an accessible busy state", () => {
  render(ZToolsSourceBuildStatus, { sourcePath: path, entry: { phase: "installing", runId: "run", message: "", observationError: "",
    runtime: { active: true, stage: "installing", cancellable: false, cancelRequested: false } },
    oninspect: vi.fn(), onconvert: vi.fn(), oncancel: vi.fn(), onresume: vi.fn(), onrescan: vi.fn() });
  expect(screen.getByLabelText("源码转换").getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("正在安装转换结果，此步骤不能取消。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "取消转换" })).toBeNull();
});

it("keeps an observation failure separate from task completion and offers the same-task retry", async () => {
  const onresume = vi.fn();
  render(ZToolsSourceBuildStatus, { sourcePath: path, entry: { phase: "building", runId: "run", message: "", observationError: "暂时无法读取任务状态" },
    oninspect: vi.fn(), onconvert: vi.fn(), oncancel: vi.fn(), onresume, onrescan: vi.fn() });
  expect(screen.getByRole("alert").textContent).toBe("暂时无法读取任务状态");
  await fireEvent.click(screen.getByRole("button", { name: "继续读取任务" }));
  expect(onresume).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
});


it("requires an explicit root/public choice, reinspects that choice, and carries its digest into conversion", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  let conflict = true;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") {
      return inspectionTask(args.arguments as Record<string, unknown>, inspectionOutput((args.arguments as Record<string, unknown>).manifestSelection as "root" | "public" | undefined, conflict));
    }
    if (command === "start_agent_tool" && args?.name === "convert_ztools_plugin") { conversionInput = args.arguments as Record<string, unknown>; return task("succeeded", conversionInput); }
    return base(command, args);
  });
  render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: /^检查可转换版本$/ }));
  expect(screen.getByText(/两份清单存在差异/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
  await fireEvent.click(screen.getAllByRole("button", { name: "选择并重新检查" })[0]);
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "inspect_ztools_source_build")).toHaveLength(2));
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "inspect_ztools_source_build")[1][1].arguments)
    .toEqual({ sourcePath: path, manifestSelection: "root" });
  await fireEvent.click(screen.getByRole("button", { name: "选择并重新检查" }));
  await screen.findByRole("button", { name: "一键转换并安装" });
  await fireEvent.click(screen.getByRole("button", { name: "一键转换并安装" }));
  const calls = mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin");
  expect(calls).toHaveLength(1);
  expect(calls[0][1].arguments).toMatchObject({ manifestSelection: "public", expectedManifestSha256: "c".repeat(64), expectedRevision: revision });
  const inspections = mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "inspect_ztools_source_build");
  expect(inspections.map(([, args]) => args.arguments)).toEqual([{ sourcePath: path }, { sourcePath: path, manifestSelection: "root" }, { sourcePath: path, manifestSelection: "public" }]);
});


it("does not offer conversion until an eligible result without a resolved manifest is explicitly reinspected", async () => {
  const output: Record<string, unknown> = {
    ...inspectionOutput("root"), manifestSelection: null, manifestSha256: null, manifestIdentity: null, manifestDifferences: [],
  };
  const onselectmanifest = vi.fn();
  render(ZToolsSourceBuildStatus, { sourcePath: path, entry: { phase: "eligible", inspection: output as unknown as SourceBuildInspection, message: "", observationError: "" },
    oninspect: vi.fn(), onconvert: vi.fn(), oncancel: vi.fn(), onresume: vi.fn(), onrescan: vi.fn(), onselectmanifest });
  expect(screen.getByRole("status").textContent).toContain("尚未确认转换所用的源码清单");
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
  await fireEvent.click(screen.getAllByRole("button", { name: "选择并重新检查" })[0]);
  expect(onselectmanifest).toHaveBeenCalledWith("root");
});
