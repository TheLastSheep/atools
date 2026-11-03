import { afterEach, expect, it, vi } from "vitest";
import { createNativeImageToolboxPageProbe } from "./nativeImageToolboxPageProbe";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

it("keeps unobserved state distinct from explicit false and true snapshots", () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  expect(emit).not.toHaveBeenCalled();
  probe.install();
  expect(emit).toHaveBeenCalledWith("frame-observer-installed", undefined);
  probe.snapshotAfterTick();
  expect(emit).toHaveBeenCalledWith("frame-presence-after-tick", false);
  expect(emit).toHaveBeenCalledWith("frame-source-assigned-after-tick", false);
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  document.body.append(frame);
  probe.snapshotAfterTick();
  expect(emit).toHaveBeenCalledWith("frame-presence-after-tick", true);
});

it("ignores initial about:blank loads and reports only a later source-attribute load event", async () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  probe.install();
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  document.body.append(frame);
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  expect(emit).not.toHaveBeenCalledWith("frame-load-after-source-attribute-mutation", true);
  frame.setAttribute("src", "about:blank");
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  expect(emit).toHaveBeenCalledWith("frame-source-attribute-assigned", true);
  expect(emit).toHaveBeenCalledWith("frame-load-after-source-attribute-mutation", true);
});

it("observes a source attribute already present when the plugin frame is inserted", async () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  probe.install();
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  frame.setAttribute("src", "about:blank");
  document.body.append(frame);
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  expect(emit).toHaveBeenCalledWith("frame-source-attribute-assigned", true);
  expect(emit).toHaveBeenCalledWith("frame-load-after-source-attribute-mutation", true);
});

it("stops inspecting DOM mutations after its fixed work budget", async () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  probe.install();
  const burst = document.createDocumentFragment();
  for (let i = 0; i < 140; i++) burst.append(document.createElement("span"));
  document.body.append(burst);
  await Promise.resolve();
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  frame.setAttribute("src", "about:blank");
  document.body.append(frame);
  await Promise.resolve();
  expect(emit.mock.calls.length).toBeLessThanOrEqual(12);
  expect(emit).not.toHaveBeenCalledWith("frame-source-attribute-assigned", true);
});

it("deduplicates repeated mutations and error events under the fixed observation cap", async () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  probe.install();
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  document.body.append(frame);
  for (let i = 0; i < 80; i++) {
    frame.setAttribute("src", `about:blank#${i}`);
    window.dispatchEvent(new Event("error"));
    window.dispatchEvent(new Event("unhandledrejection"));
  }
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  expect(emit.mock.calls.filter(([code]) => code === "frame-source-attribute-assigned")).toHaveLength(1);
  expect(emit.mock.calls.filter(([code]) => code === "top-window-error")).toHaveLength(1);
  expect(emit.mock.calls.filter(([code]) => code === "top-unhandled-rejection")).toHaveLength(1);
  expect(emit.mock.calls.length).toBeLessThanOrEqual(12);
});

it("does not invoke the sink for late events after dispose", async () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  probe.install();
  const beforeDispose = emit.mock.calls.length;
  probe.dispose();
  window.dispatchEvent(new Event("error"));
  window.dispatchEvent(new Event("unhandledrejection"));
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  frame.setAttribute("src", "about:blank");
  document.body.append(frame);
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  expect(emit.mock.calls).toHaveLength(beforeDispose);
});

it("records the configured panel load-error callback once without exposing details", () => {
  const emit = vi.fn();
  const probe = createNativeImageToolboxPageProbe(document, window, emit);
  dispose = probe.dispose;
  probe.install();
  probe.markPanelLoadErrorHandlerInstalled();
  probe.markPanelLoadError();
  probe.markPanelLoadError();
  expect(emit).toHaveBeenCalledWith("panel-load-error-observer-installed", undefined);
  expect(emit).toHaveBeenCalledTimes(4);
  expect(emit).toHaveBeenCalledWith("panel-load-error", true);
});
