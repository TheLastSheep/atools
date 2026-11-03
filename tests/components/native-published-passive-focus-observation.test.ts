import { afterEach, expect, it, vi } from "vitest";
import { createPassiveFocusObserver } from "./nativePublishedPassiveFocusObservation";

afterEach(() => { document.body.replaceChildren(); });

const snapshot = {
  mode: "observe", nativeVisible: true, nativeFocused: false, appActive: false, appHidden: false,
  frontmostIsSelf: false, windowOcclusionVisible: true,
};

it("keeps three fixed stages, samples passively once, and never treats observation as a pass", async () => {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    expect(command).toBe("native_panel_foreground");
    expect(args).toEqual({ ensure: false });
    return snapshot;
  });
  const observer = createPassiveFocusObserver(document, invoke);
  expect(Object.values(observer.records)).toEqual([{ status: "not_sampled" }, { status: "not_sampled" }, { status: "not_sampled" }]);
  await observer.sample("startupAfterShow");
  await observer.sample("startupAfterShow");
  await observer.sample("beforePluginActivation");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(observer.records.startupAfterShow.status).toBe("observed");
  if (observer.records.startupAfterShow.status === "observed") {
    expect(observer.records.startupAfterShow.native.nativeVisible).toBe(true);
    expect(observer.records.startupAfterShow.native.nativeFocused).toBe(false);
  }
  expect(observer.records.afterPluginReturn).toEqual({ status: "not_sampled" });
});

it("separates unsupported native shape and command errors without retaining raw error text", async () => {
  const missing = createPassiveFocusObserver(document, vi.fn(async () => ({ ...snapshot, windowOcclusionVisible: null })));
  await missing.sample("startupAfterShow");
  expect(missing.records.startupAfterShow).toMatchObject({ status: "unsupported", reason: "native_snapshot_fields_unavailable" });

  const failed = createPassiveFocusObserver(document, vi.fn(async () => { throw Error("/private/path/secret"); }));
  await failed.sample("beforePluginActivation");
  expect(failed.records.beforePluginActivation).toMatchObject({ status: "error", reason: "native_snapshot_failed" });
  expect(JSON.stringify(failed.records)).not.toContain("/private/path/secret");
});

it("maps the existing bounded diagnostic timeout to an error record without late sample mutation", async () => {
  let release!: (value: unknown) => void;
  const delayed = new Promise<unknown>(resolve => { release = resolve; });
  const invoke = vi.fn(async () => delayed);
  const observer = createPassiveFocusObserver(document, invoke, read => Promise.race([
    read(), Promise.resolve({ unavailable: true, reason: "diagnostic-timeout" }),
  ]));
  await observer.sample("afterPluginReturn");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(observer.records.afterPluginReturn).toEqual({ status: "error", reason: "native_snapshot_failed", renderer: expect.any(Object) });
  release(snapshot);
  await Promise.resolve();
  expect(observer.records.afterPluginReturn.status).toBe("error");
});
