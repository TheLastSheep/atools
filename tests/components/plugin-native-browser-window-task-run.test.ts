import { describe, expect, it, vi } from "vitest";
import {
  validatePluginNativeBrowserWindowIntent,
  waitForPluginNativeBrowserWindowRun,
  type PluginNativeBrowserWindowInvoke,
} from "../../src/lib/pluginNativeBrowserWindowTaskRun";
import type { TaskRun } from "../../src/lib/types";

const runId = "run-11111111-1111-4111-8111-111111111111";
const otherRunId = "run-22222222-2222-4222-8222-222222222222";
const intentId = "a".repeat(64);
const tool = "atools.host.browser-window.0123456789abcdef01234567";

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    intentId,
    runId,
    permission_required: true,
    client_id: "atools-ui",
    tool,
    arguments: { operation: "open", intentId },
    ...overrides,
  };
}

function task(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: runId,
    capabilityId: tool,
    initiator: { type: "human", clientId: "atools-ui" },
    status: "succeeded",
    input: { operation: "open", intentId },
    output: { windowId: "window-1" },
    artifacts: [],
    warnings: [],
    errors: [],
    actions: [],
    memoryIds: [],
    metrics: {},
    validation: { status: "not_run" },
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    ...overrides,
  };
}

function opened() {
  return validatePluginNativeBrowserWindowIntent(prepared(), "open", intentId, tool);
}

type TaskEventReceiver = (event: { payload: string }) => void;

function eventListener(unlisten = vi.fn()) {
  const receivers: Array<{ event: string; receive: TaskEventReceiver }> = [];
  const listen = async <T,>(event: string, receive: (event: { payload: T }) => void) => {
    receivers.push({ event, receive: receive as TaskEventReceiver });
    return unlisten;
  };
  return { receivers, listen, unlisten };
}

describe("native browser-window TaskRun binding", () => {
  it("accepts only the exact prepared run, client, tool and operation input", () => {
    expect(opened()).toMatchObject({ runId, client_id: "atools-ui", tool });

    const invalid = [
      prepared({ intentId: "b".repeat(64) }),
      prepared({ runId: "not-a-uuid" }),
      prepared({ runId: "11111111-1111-4111-8111-111111111111" }),
      prepared({ client_id: "another-client" }),
      prepared({ tool: "atools.host.browser-window.ffffffffffffffffffffffff" }),
      prepared({ permission_required: "yes" }),
      prepared({ arguments: { operation: "action", intentId } }),
      prepared({ arguments: { operation: "open", intentId, url: "PRIVATE_URL" } }),
      prepared({ arguments: ["open", intentId] }),
    ];
    for (const value of invalid) {
      expect(() => validatePluginNativeBrowserWindowIntent(value, "open", intentId, tool))
        .toThrow(/INVALID_TASK_BINDING/);
    }
    expect(() => validatePluginNativeBrowserWindowIntent(null, "open", intentId, tool))
      .toThrow(/INVALID_TASK/);
  });

  it("waits for the matching update, returns success and removes its listener", async () => {
    const event = eventListener();
    let firstPoll!: () => void;
    const firstPollStarted = new Promise<void>(resolve => { firstPoll = resolve; });
    let calls = 0;
    const invoke: PluginNativeBrowserWindowInvoke = async <T,>() => {
      calls++;
      if (calls === 1) {
        firstPoll();
        return task({ status: "running" }) as T;
      }
      return task() as T;
    };
    const assertCurrent = vi.fn();
    const openedIntent = opened();
    const waiting = waitForPluginNativeBrowserWindowRun({
      opened: openedIntent,
      operation: "open",
      intentId,
      invoke,
      assertCurrent,
      listen: event.listen,
      timeoutMs: 5_000,
    });

    await firstPollStarted;
    expect(event.receivers[0]?.event).toBe("task-run-updated");
    event.receivers[0]?.receive({ payload: runId });
    await expect(waiting).resolves.toMatchObject({ id: runId, status: "succeeded" });

    expect(calls).toBe(2);
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(event.unlisten).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled", "partial"] as const)(
    "rejects a %s run and removes its listener",
    async status => {
      const event = eventListener();
      const invoke: PluginNativeBrowserWindowInvoke = async <T,>() => task({ status }) as T;
      await expect(waitForPluginNativeBrowserWindowRun({
        opened: opened(),
        operation: "open",
        intentId,
        invoke,
        assertCurrent() {},
        listen: event.listen,
      })).rejects.toThrow(/PERMISSION_DENIED/);
      expect(event.unlisten).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects TaskRuns whose id, capability, initiator or exact input differs", async () => {
    const mismatches: Partial<TaskRun>[] = [
      { id: otherRunId },
      { capabilityId: "atools.host.browser-window.ffffffffffffffffffffffff" },
      { initiator: { type: "agent", clientId: "atools-ui" } },
      { initiator: { type: "human", clientId: "other-client" } },
      { input: { operation: "open", intentId, extra: true } },
      { input: { operation: "action", intentId } },
    ];

    for (const mismatch of mismatches) {
      const event = eventListener();
      const invoke: PluginNativeBrowserWindowInvoke = async <T,>() => task(mismatch) as T;
      await expect(waitForPluginNativeBrowserWindowRun({
        opened: opened(),
        operation: "open",
        intentId,
        invoke,
        assertCurrent() {},
        listen: event.listen,
      })).rejects.toThrow(/TASK_BINDING_MISMATCH/);
      expect(event.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("stops polling when the source lease becomes stale and removes the listener", async () => {
    const event = eventListener();
    const invoke: PluginNativeBrowserWindowInvoke = async <T,>() => task({ status: "running" }) as T;
    const assertCurrent = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      throw new Error("stale source");
    });

    await expect(waitForPluginNativeBrowserWindowRun({
      opened: opened(),
      operation: "open",
      intentId,
      invoke,
      assertCurrent,
      listen: event.listen,
    })).rejects.toThrow("stale source");
    expect(event.unlisten).toHaveBeenCalledTimes(1);
  });
});
