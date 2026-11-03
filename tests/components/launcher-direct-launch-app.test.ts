import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), records: [] as {
        receive: Function;
        stop: ReturnType<typeof vi.fn>;
        resolve?: () => void;
    }[], delay: false }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, receive) => {
        if (name !== "atools://direct-launch-plugin")
            return () => { };
        const record = { receive, stop: vi.fn(), resolve: undefined as (() => void) | undefined };
        mocks.records.push(record);
        if (mocks.delay)
            await new Promise<void>(resolve => record.resolve = resolve);
        return record.stop;
    }) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({ default: (await import("./LauncherMediaPluginFixture.svelte")).default }));
beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.records = [];
    mocks.delay = false;
    localStorage.clear();
    Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
    localStorage.setItem("atools-settings", JSON.stringify({ autoPaste: "never", showRecentInSearch: false }));
    mocks.invoke.mockImplementation(async (command, args = {}) => {
        if (command === "get_setting")
            return localStorage.getItem("atools-settings");
        if (command === "feature_catalog" || command === "list_pending_agent_requests")
            return [];
        if (command === "activate_feature")
            return { plugin_id: args.expectedPluginId ?? "lost-owner", feature_code: args.code, payload: null, main_url: "index.html", plugin_path: "/fixture", expand_height: 500 };
        return undefined;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function mountApp() { const view = render(App, { backgroundServices: false }); await waitFor(() => expect(mocks.records.length).toBeGreaterThan(0)); return view; }
const activations = () => mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature");
it.each([{ pluginId: "canonical-owner" }, { plugin_id: "legacy-owner" }, { pluginId: "both-owner", plugin_id: "both-owner" }])("passes a validated direct-launch owner to native activation: %j", async (identity) => {
    await mountApp();
    mocks.records[0].receive({ payload: { code: "owned-code", ...identity } });
    await waitFor(() => expect(activations()).toHaveLength(1));
    expect(activations()[0][1]).toEqual({ code: "owned-code", payload: null, expectedPluginId: identity.pluginId ?? identity.plugin_id });
});
it.each([{ pluginId: "owner-a", plugin_id: "owner-b" }, { pluginId: "" }, { pluginId: null }, { pluginId: 4 }, {}])("rejects conflicting or invalid direct-launch owner: %j", async (identity) => {
    await mountApp();
    mocks.records[0].receive({ payload: { code: "owned-code", ...identity } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(activations()).toHaveLength(0);
});
it("unsubscribes on actual App unmount and rejects stale callbacks after remount", async () => {
    const first = await mountApp();
    const previous = mocks.records[0];
    first.unmount();
    expect(previous.stop).toHaveBeenCalledOnce();
    await mountApp();
    for (const record of mocks.records)
        record.receive({ payload: { code: "owned-code", pluginId: "owner" } });
    await waitFor(() => expect(activations()).toHaveLength(1));
});
it("stops a late-resolving native subscription after actual App unmount", async () => {
    mocks.delay = true;
    const view = await mountApp();
    const record = mocks.records[0];
    view.unmount();
    record.receive({ payload: { code: "owned-code", pluginId: "owner" } });
    record.resolve!();
    await waitFor(() => expect(record.stop).toHaveBeenCalledOnce());
    record.receive({ payload: { code: "owned-code", pluginId: "owner" } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(activations()).toHaveLength(0);
});
