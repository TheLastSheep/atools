// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { PluginBrowserWindowParentMessage, PluginBrowserWindowState } from "../../src/lib/pluginBrowserWindowTypes";
import { createPluginBrowserWindowState } from "../../src/lib/pluginBrowserWindowState";

function windowState(hostKind: "native" | "overlay", backgroundThrottling: boolean): PluginBrowserWindowState {
  return { id: "child", hostKind, backgroundThrottling, zOrder: 1 } as PluginBrowserWindowState;
}

describe("BrowserWindow background-throttling state updates", () => {
  it("rejects direct native state updates without changing the window or last message", () => {
    const native = windowState("native", false);
    const windows = [native];
    const lastMessage = { windowId: "previous", channel: "previous", args: [] } as PluginBrowserWindowParentMessage;
    let currentMessage = lastMessage;
    const setLastMessage = vi.fn((message: PluginBrowserWindowParentMessage) => { currentMessage = message; });
    const access = { getWindows: () => windows, setWindows: vi.fn(), setLastMessage };
    const state = createPluginBrowserWindowState(access);

    expect(() => state.updatePluginBrowserWindowBackgroundThrottling("child", true)).toThrowError(expect.objectContaining({
      code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED",
    }));
    expect(access.getWindows()).toBe(windows);
    expect(access.getWindows()[0]).toBe(native);
    expect(access.setWindows).not.toHaveBeenCalled();
    expect(setLastMessage).not.toHaveBeenCalled();
    expect(currentMessage).toBe(lastMessage);
  });

  it("retains legacy state mutation and notification", () => {
    const overlay = windowState("overlay", true);
    let windows = [overlay];
    const setLastMessage = vi.fn();
    const state = createPluginBrowserWindowState({ getWindows: () => windows,
      setWindows: next => { windows = next; }, setLastMessage });

    expect(state.updatePluginBrowserWindowBackgroundThrottling("child", false)).toMatchObject({ backgroundThrottling: false });
    expect(windows[0].backgroundThrottling).toBe(false);
    expect(setLastMessage).toHaveBeenCalledWith({ windowId: "child", channel: "webContents:setBackgroundThrottling", args: [false] });
  });
});
