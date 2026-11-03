import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import type { FeatureAction } from "../../src/lib/types";

const action: FeatureAction = {
  plugin_id: "frame-focus-fixture",
  plugin_name: "Frame focus fixture",
  feature_code: "open",
  plugin_path: "__atools_plugin_host_preview__",
  main_url: "index.html",
  expand_height: 400,
  payload: { srcdoc: "<!doctype html><main>synthetic focus fixture</main>" },
};

let frameFocus: ReturnType<typeof vi.spyOn>;
let documentHasFocus: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  documentHasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  frameFocus = vi.spyOn(HTMLIFrameElement.prototype, "focus");
});

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-permission-dialog]").forEach(node => node.remove());
  frameFocus.mockRestore();
  documentHasFocus.mockRestore();
});

async function mountedFrame() {
  return waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(frame).toBeTruthy();
    expect(frame?.srcdoc).toContain("synthetic focus fixture");
    return frame!;
  });
}

function sendFrameMessage(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  const epoch = Number(frame.dataset.pluginInputEpoch);
  window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow,
    data: { epoch, generation: epoch, ...data },
  }));
}

it("hands initial unclaimed focus to the iframe through PluginPanel mount", async () => {
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();

  await waitFor(() => expect(document.activeElement).toBe(frame));
  expect(frameFocus).toHaveBeenCalledWith({ preventScroll: true });
  view.unmount();
});

it("hands focus to the iframe when its load completes after the document regains focus", async () => {
  documentHasFocus.mockReturnValue(false);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  expect(frameFocus).not.toHaveBeenCalled();

  documentHasFocus.mockReturnValue(true);
  frame.dispatchEvent(new Event("load"));

  await waitFor(() => expect(document.activeElement).toBe(frame));
  expect(frameFocus).toHaveBeenCalledWith({ preventScroll: true });
  view.unmount();
});

it.each([
  ["navigation input", () => Object.assign(document.createElement("input"), { type: "text" })],
  ["navigation button", () => document.createElement("button")],
])("does not steal focus from a %s when the iframe load arrives late", async (_label, makeControl) => {
  documentHasFocus.mockReturnValue(false);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  expect(frameFocus).not.toHaveBeenCalled();

  const control = makeControl();
  document.body.append(control);
  control.focus();
  expect(document.activeElement).toBe(control);
  documentHasFocus.mockReturnValue(true);
  frame.dispatchEvent(new Event("load"));

  expect(frameFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(control);
  control.remove();
  view.unmount();
});

it("does not take focus from the body while a permission modal is present", async () => {
  const modal = document.createElement("section");
  modal.setAttribute("data-permission-dialog", "");
  document.body.append(modal);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  frame.dispatchEvent(new Event("load"));

  expect(document.activeElement).toBe(document.body);
  expect(frameFocus).not.toHaveBeenCalled();
  view.unmount();
  modal.remove();
});

it("honors iframe focus and pending select requests without refocusing the main frame", async () => {
  documentHasFocus.mockReturnValue(false);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  expect(frameFocus).not.toHaveBeenCalled();

  documentHasFocus.mockReturnValue(true);
  sendFrameMessage(frame, { __ipc_subinput__: true, opts: { visible: true, value: "query", focus: false } });
  const input = await waitFor(() => {
    const value = document.querySelector<HTMLInputElement>('input[aria-label="插件搜索"]');
    expect(value).toBeTruthy();
    return value!;
  });
  const select = vi.spyOn(input, "select");
  sendFrameMessage(frame, { __ipc_subinput_focus__: true, action: "select" });
  frame.dispatchEvent(new Event("load"));

  await waitFor(() => expect(select).toHaveBeenCalledOnce());
  expect(document.activeElement).toBe(input);
  expect(frameFocus).not.toHaveBeenCalled();
  view.unmount();
});

it("does not honor delayed sub-input focus after a permission modal appears", async () => {
  documentHasFocus.mockReturnValue(false);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();

  sendFrameMessage(frame, { __ipc_subinput__: true, opts: { visible: true, focus: true } });
  const modal = document.createElement("section");
  modal.setAttribute("data-permission-dialog", "");
  document.body.append(modal);
  documentHasFocus.mockReturnValue(true);
  frame.dispatchEvent(new Event("load"));

  const input = await waitFor(() => {
    const value = document.querySelector<HTMLInputElement>('input[aria-label="插件搜索"]');
    expect(value).toBeTruthy();
    return value!;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await waitFor(() => expect(document.activeElement).toBe(document.body));
  expect(document.activeElement).not.toBe(input);
  expect(frameFocus).not.toHaveBeenCalled();
  view.unmount();
  modal.remove();
});

it("does not reclaim frame focus when a real remove message blurs the sub-input", async () => {
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  sendFrameMessage(frame, { __ipc_subinput__: true, opts: { visible: true, value: "query", focus: true } });
  const input = await waitFor(() => {
    const value = document.querySelector<HTMLInputElement>('input[aria-label="插件搜索"]');
    expect(value).toBeTruthy();
    return value!;
  });
  await waitFor(() => expect(document.activeElement).toBe(input));

  const navigationButton = document.createElement("button");
  document.body.append(navigationButton);
  navigationButton.focus();
  frameFocus.mockClear();
  sendFrameMessage(frame, { __ipc_subinput_remove__: true });

  await waitFor(() => expect(document.querySelector('input[aria-label="插件搜索"]')).toBeNull());
  expect(document.activeElement).toBe(navigationButton);
  expect(frameFocus).not.toHaveBeenCalled();
  navigationButton.remove();
  view.unmount();
});

it("does not focus a stale frame when its load event arrives after unmount", async () => {
  documentHasFocus.mockReturnValue(false);
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await mountedFrame();
  expect(frameFocus).not.toHaveBeenCalled();
  view.unmount();

  documentHasFocus.mockReturnValue(true);
  frame.dispatchEvent(new Event("load"));
  expect(frameFocus).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(frame);
});
