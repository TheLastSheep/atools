import { afterEach, describe, expect, it, vi } from "vitest";
import { approvePublishedDisplayMetadata } from "./nativePublishedDisplayPermission";
import type { PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import type { TaskRun } from "../../src/lib/types";

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativePublishedPluginCommon", async original => ({
  ...(await original<Record<string, unknown>>()), invoke: native,
}));

const DISPLAY = { id: "display-intent", run_id: "display-run", tool_name: "atools.host.display.14ff3d75f7a75dc386ed3777.read",
  client_id: "atools-ui", scopes: ["display_read"] };
const NODE = { id: "node-intent", run_id: "node-run",
  tool_name: "legacy_node_14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb",
  client_id: "atools-ui", scopes: ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
    "screenshot", "browser_context", "plugin_data", "system_settings"] };
const PROFILE = { caseId: "converted-deepread-source", id: "deepread", title: "DeepRead 深读",
  pathAccess: "none", dataAccess: true, dialogAccess: "open" } as const;
const WAITING: RuntimeState = {
  resourceLeases: 0, legacySessions: 0, legacyOpenings: 0, legacyTransport: false, pendingRequests: 1,
  hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
  dataSessions: 1, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: true,
  pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
  dialogSessions: 1, dialogIntents: 0, dialogInvocations: 0, dialogPreparations: 0, nativeDialogs: 0, dialogTransport: true,
  displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 1, displayInvocations: 0,
};

function task(id: string, capabilityId: string, status: TaskRun["status"]): TaskRun {
  return { id, capabilityId, initiator: { type: "human", clientId: "atools-ui" }, status, input: {},
    output: status === "succeeded" ? { sessionId: "display-session" } : null, artifacts: [], warnings: [], errors: [],
    actions: [], memoryIds: [], metrics: {}, validation: { status: "not_run" },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function mountDialog(title: string, onAllow: () => void) {
  document.body.innerHTML = `<section data-permission-dialog><h2>${title}</h2><button>允许一次</button></section>`;
  document.querySelector("button")!.addEventListener("click", onAllow);
}

function context() {
  return {
    profile: PROFILE,
    check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async until<T>(read: () => T | Promise<T>, label: string) {
      const value = await read(); if (value === null || value === undefined || value === false) throw Error(label);
      return value as NonNullable<T>;
    },
  } as unknown as PublishedScenarioContext;
}

function setup(options: { wrongDisplayTask?: boolean; contaminatedAfter?: Partial<RuntimeState>; nextNode?: boolean;
  nextNodeVariant?: "wrong-title" | "wrong-scope" | "wrong-capability"; resourceSessions?: string[] } = {}) {
  let approved = false, clicks = 0;
  const hasNodeGate = Boolean(options.nextNode || options.nextNodeVariant);
  const after = { ...WAITING, displaySessions: 1, displayIntents: 0,
    resourceLeases: options.resourceSessions?.length ?? 0, pendingRequests: hasNodeGate ? 1 : 0,
    ...options.contaminatedAfter };
  mountDialog("DeepRead 深读 请求读取显示器信息", () => {
    approved = true; clicks++;
    if (hasNodeGate) mountDialog(options.nextNodeVariant === "wrong-title" ? "Other 请求访问本机" : "DeepRead 深读 请求访问本机", () => { clicks++; });
    else document.body.innerHTML = "";
  });
  native.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_pending_agent_requests") {
      if (!approved) return [DISPLAY];
      if (!hasNodeGate) return [];
      if (options.nextNodeVariant === "wrong-scope") return [{ ...NODE, scopes: ["screenshot"] }];
      if (options.nextNodeVariant === "wrong-capability") return [{ ...NODE, tool_name: "legacy_node_" + "0".repeat(64) }];
      return [NODE];
    }
    if (command === "get_task_run" && args?.id === "display-run") return options.wrongDisplayTask
      ? task("different-run", DISPLAY.tool_name, approved ? "succeeded" : "awaiting_permission")
      : task("display-run", DISPLAY.tool_name, approved ? "succeeded" : "awaiting_permission");
    if (command === "get_task_run" && args?.id === "node-run") return task("node-run", NODE.tool_name, "awaiting_permission");
    if (command === "native_published_runtime_state") return approved ? after : WAITING;
    if (command === "native_published_resource_sessions") return approved ? options.resourceSessions ?? [] : [];
    throw Error("Unexpected fixture command or argument: " + command);
  });
  return { clicks: () => clicks, approved: () => approved };
}

afterEach(() => { document.body.innerHTML = ""; native.mockReset(); });

describe("DeepRead display permission async wire", () => {
  it("uses the exact TaskRun id and leaves the later Node gate for its own approval", async () => {
    const fixture = setup({ nextNode: true });
    const result = await approvePublishedDisplayMetadata(context());
    expect(native).toHaveBeenCalledWith("get_task_run", { id: "display-run" });
    expect(result).toMatchObject({ capability: DISPLAY.tool_name, scope: "display_read", completedTaskRun: "display-run",
      nextGate: "node", nextNodeTaskRun: "node-run", screenPixelsRead: false, nativePanelRequestedByScenario: false });
    expect(fixture.approved()).toBe(true);
    expect(fixture.clicks()).toBe(1);
    expect(document.querySelector("h2")?.textContent).toBe("DeepRead 深读 请求访问本机");
  });

  it("accepts one aggregate asset lease only when the owner-bound fixture query confirms it", async () => {
    setup({ resourceSessions: ["fixture-private-session-id"] });
    const result = await approvePublishedDisplayMetadata(context());
    expect(result.after.resourceLeases).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fixture-private-session-id");
  });

  it.each([
    { contaminatedAfter: { resourceLeases: 1 } },
    { resourceSessions: ["fixture-private-session-id"], contaminatedAfter: { resourceLeases: 0 } },
    { resourceSessions: ["one", "two"] },
  ])("rejects an unowned, inconsistent, or multiple asset lease state", async options => {
    setup(options);
    await expect(approvePublishedDisplayMetadata(context())).rejects.toThrow("exact next DeepRead Node gate");
  });

  it("refuses approval when the pending display TaskRun id does not match", async () => {
    const fixture = setup({ wrongDisplayTask: true });
    await expect(approvePublishedDisplayMetadata(context())).rejects.toThrow("exact pending DeepRead TaskRun");
    expect(fixture.approved()).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it.each([
    { hostSessions: 1 }, { legacySessions: 1 }, { activePathSnapshots: 1 }, { nativeDialogs: 1 },
    { displayInvocations: 1 }, { dataSessions: 0 }, { dialogSessions: 0 },
  ])("rejects contaminated post-approval state %#", async contamination => {
    const fixture = setup({ contaminatedAfter: contamination });
    await expect(approvePublishedDisplayMetadata(context())).rejects.toThrow("exact next DeepRead Node gate");
    expect(fixture.clicks()).toBe(1);
    expect(fixture.approved()).toBe(true);
  });

  it.each(["wrong-title", "wrong-scope", "wrong-capability"] as const)(
    "does not accept a nonmatching next permission as the Node gate (%s)", async nextNodeVariant => {
      const fixture = setup({ nextNodeVariant });
      await expect(approvePublishedDisplayMetadata(context())).rejects.toThrow("exact next DeepRead Node gate");
      expect(fixture.clicks()).toBe(1);
      expect(document.querySelector("button")?.textContent).toBe("允许一次");
    });
});
