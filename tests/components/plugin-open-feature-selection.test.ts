import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exactOpenablePluginFeature,
  firstOpenablePluginFeature,
  PLUGIN_OPEN_REQUESTED_EVENT,
  PluginOpenController,
} from "../../src/lib/pluginOpen";
import type { InstalledPlugin } from "../../src/lib/types";

function plugin(id: string, enabled = true): InstalledPlugin {
  return {
    id, name: id, version: "1", path: `/plugins/${id}`, enabled,
    created_at: "", updated_at: "",
    manifest: { features: [
      { code: "shared:command", label: "同名指令 A", explain: "first" },
      { code: "other:command", label: "其他指令", explain: "second" },
    ] },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("plugin open feature selection", () => {
  it("preserves the legacy first-feature resolver when no selection is supplied", () => {
    expect(firstOpenablePluginFeature(plugin("one"))).toEqual({ code: "shared:command", pluginId: "one" });
    const opener = new PluginOpenController(() => {}, () => {});
    expect(opener.open(plugin("one"))).toBe(true);
  });

  it("opens only an exact code owned by the selected enabled plugin", () => {
    const one = plugin("one");
    const two = plugin("two");
    expect(exactOpenablePluginFeature(one, "other:command")).toEqual({ code: "other:command", pluginId: "one" });
    expect(exactOpenablePluginFeature(two, "shared:command")).toEqual({ code: "shared:command", pluginId: "two" });
    expect(exactOpenablePluginFeature(one, "shared")).toBeNull();
    expect(exactOpenablePluginFeature(plugin("disabled", false), "shared:command")).toBeNull();
  });

  it("sends the exact selected feature and owner in the existing activation handshake", () => {
    const opener = new PluginOpenController(() => {}, () => {});
    let received: { code: string; pluginId: string } | null = null;
    const listener = (event: Event) => {
      const request = (event as CustomEvent).detail;
      received = { code: request.code, pluginId: request.pluginId };
      event.preventDefault();
      request.respond({ status: "committed" });
    };
    window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener);
    try {
      expect(opener.open(plugin("owner-a"), "other:command")).toBe(true);
      expect(received).toEqual({ code: "other:command", pluginId: "owner-a" });
    } finally {
      window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener);
      opener.cancel();
    }
  });

  it("rejects guessed, blank, and disabled selections without dispatching a request", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const opener = new PluginOpenController(() => {}, () => {});
    expect(opener.open(plugin("owner"), "not-in-manifest")).toBe(false);
    expect(opener.open(plugin("owner"), " ")).toBe(false);
    expect(opener.open(plugin("disabled", false), "shared:command")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
