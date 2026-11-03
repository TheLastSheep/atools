import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriTransport } from "../../packages/ztools-renderer/src/tauriTransport";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

describe("original renderer native transport", () => {
  beforeEach(() => { native.invoke.mockReset(); native.listen.mockReset(); });

  it("listens only to the main Window focus and omits foreign window context", async () => {
    const stop = vi.fn();
    native.listen.mockResolvedValue(stop);
    const callback = vi.fn();
    const unlisten = await createTauriTransport().listen("tauri://focus", callback);
    expect(native.listen).toHaveBeenCalledWith("tauri://focus", expect.any(Function), {
      target: { kind: "Window", label: "main" },
    });
    const handler = native.listen.mock.calls[0][1];
    handler({ payload: { title: "must not cross this adapter" } });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(undefined);
    unlisten();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("forwards app-state to the main Webview and context-menu payloads from the main Window", async () => {
    native.listen.mockImplementation(async (_event, callback) => {
      callback({ payload: { revision: 4 } });
      return vi.fn();
    });

    for (const [event, kind] of [
      ["atools://renderer-app-state", "Webview"],
      ["atools://renderer-app-launched", "Webview"],
      ["atools://renderer-apps-changed", "Webview"],
      ["atools://renderer-plugins-changed", "Webview"],
      ["atools://renderer-settings-view", "Webview"],
      ["atools://renderer-general-settings", "Webview"],
      ["atools://renderer-command-aliases", "Webview"],
      ["atools://renderer-disabled-commands", "Webview"],
      ["atools://renderer-local-shortcuts", "Webview"],
      ["atools://renderer-context-menu", "Window"],
    ] as const) {
      const callback = vi.fn();
      await createTauriTransport().listen(event, callback);
      expect(native.listen).toHaveBeenLastCalledWith(event, expect.any(Function), {
        target: { kind, label: "main" },
      });
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith({ revision: 4 });
    }
  });

  it("forwards local shortcut changes only to the main Webview and returns its unlisten handle", async () => {
    const stop = vi.fn();
    native.listen.mockResolvedValue(stop);
    const callback = vi.fn();
    const payload = { version: 1, revision: 12 };
    const unlisten = await createTauriTransport().listen("atools://renderer-local-shortcuts", callback);

    expect(native.listen).toHaveBeenCalledWith("atools://renderer-local-shortcuts", expect.any(Function), {
      target: { kind: "Webview", label: "main" },
    });
    native.listen.mock.calls[0][1]({ payload });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(payload);
    unlisten();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses unimplemented events before registering with Tauri", async () => {
    await expect(createTauriTransport().listen("tauri://blur", vi.fn())).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    await expect(createTauriTransport().listen("builtin-plugins-loaded", vi.fn())).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    expect(native.listen).not.toHaveBeenCalled();
  });
});
