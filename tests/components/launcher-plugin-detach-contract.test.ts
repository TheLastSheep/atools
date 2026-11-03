import { expect, it, vi } from "vitest";
import { createLauncherPluginDetachBridge, parseDetachedPluginRequest, pluginDetachOpenArgs } from "../../src/lib/launcherPluginDetachContract";
import type { FeatureAction } from "../../src/lib/types";

const action: FeatureAction = {
  plugin_id: "harris.plugin",
  plugin_name: "Harris Plugin",
  feature_code: "format",
  main_url: "index.html",
  plugin_path: "/plugins/harris",
  expand_height: 500,
  payload: { text: "exact payload", nested: [1, 2] },
  entry_type: "over",
};

it("uses only the opaque handoff id and gives it priority over legacy route fields", () => {
  expect(parseDetachedPluginRequest("#/plugin-detach?handoff=once%2Fid&feature_code=legacy&plugin_id=old", true))
    .toEqual({ kind: "handoff", handoffId: "once/id" });
  expect(parseDetachedPluginRequest("#/plugin-detach?handoff=", true)).toEqual({ kind: "handoff", handoffId: "" });
});

it("keeps feature_code/plugin_id routing as a legacy-only fallback", () => {
  expect(parseDetachedPluginRequest("#/plugin-detach?feature_code=%20format%20&plugin_id=%20harris.plugin%20", true))
    .toEqual({ kind: "legacy", featureCode: "format", pluginId: "harris.plugin" });
  expect(parseDetachedPluginRequest("#/plugin-detach?feature_code=", true)).toBeNull();
  expect(parseDetachedPluginRequest("#/plugin-detach?handoff=once", false)).toBeNull();
});

it("preserves the action payload and entry type for Rust validation", () => {
  const args = pluginDetachOpenArgs(action);
  expect(args).toEqual({
    featureCode: "format",
    pluginId: "harris.plugin",
    payload: action.payload,
    entryType: "over",
  });
  expect(args.payload).toBe(action.payload);
});

it("cancels only the completed native open when its activation intent became stale", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let finish!: () => void;
  let current = true;
  const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "open_plugin_detach_window") await new Promise<void>(resolve => { finish = resolve; });
    return undefined;
  }) as unknown as Parameters<typeof createLauncherPluginDetachBridge>[0];
  const bridge = createLauncherPluginDetachBridge(invoke);
  const opened = bridge.openPluginDetachAction(action, () => current);
  const requestId = calls[0]?.args.requestId;
  expect(requestId).toEqual(expect.any(String));
  expect(calls[0]?.args).toMatchObject({
    featureCode: action.feature_code,
    pluginId: action.plugin_id,
    payload: action.payload,
    entryType: action.entry_type,
    requestId,
  });

  current = false;
  finish();
  expect(await opened).toBe(false);
  expect(calls.at(-1)).toEqual({ command: "cancel_plugin_detach_open", args: { requestId } });
});

it("keeps a current detach open to one native request without cleanup RPC", async () => {
  const invoke = vi.fn(async () => undefined) as unknown as Parameters<typeof createLauncherPluginDetachBridge>[0];
  const bridge = createLauncherPluginDetachBridge(invoke);
  expect(await bridge.openPluginDetachAction(action, () => true)).toBe(true);
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("open_plugin_detach_window", expect.objectContaining({ requestId: expect.any(String) }));
});

it("does not report stale cleanup as confirmed when the native cancel request fails", async () => {
  const calls: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const invoke = vi.fn(async (command: string) => {
    calls.push(command);
    if (command === "cancel_plugin_detach_open") throw new Error("native cleanup unavailable");
    return undefined;
  }) as unknown as Parameters<typeof createLauncherPluginDetachBridge>[0];
  try {
    const bridge = createLauncherPluginDetachBridge(invoke);
    expect(await bridge.openPluginDetachAction(action, () => false)).toBe(false);
    expect(calls).toEqual(["open_plugin_detach_window", "cancel_plugin_detach_open"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("unconfirmed"), expect.any(String), expect.any(Error));
  } finally {
    warning.mockRestore();
  }
});
