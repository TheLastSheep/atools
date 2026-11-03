import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import SettingsConfirmDialog from "../../src/components/SettingsConfirmDialog.svelte";
import PermissionPromptHost from "../../src/components/PermissionPromptHost.svelte";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";

let view: ReturnType<typeof mount> | undefined, permissionView: ReturnType<typeof mount> | undefined, previous: HTMLButtonElement;
const cancel = vi.fn(), confirm = vi.fn();
beforeEach(async () => {
  document.body.innerHTML = '<button id="launch">安装插件</button><div id="target"></div>';
  previous = document.querySelector<HTMLButtonElement>("#launch")!; previous.focus();
  cancel.mockClear(); confirm.mockClear();
  view = mount(SettingsConfirmDialog, { target: document.querySelector("#target")!, props: {
    title: "安装插件 · 发布版本已变化", message: "你选择的是 v1，当前发布版为 v2，请重新确认。",
    oncancel: cancel, onconfirm: confirm,
  } });
  await tick();
});
afterEach(async () => {
  if (view) await unmount(view); if (permissionView) await unmount(permissionView);
  view = undefined; permissionView = undefined; document.body.innerHTML = "";
});
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".confirm-actions button")];
const press = (target: EventTarget, key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event); return event;
};

it("starts on cancel and contains real focus attempts and Tab boundaries", () => {
  const [deny, allow] = buttons();
  expect(document.activeElement).toBe(deny);
  previous.focus(); expect(document.activeElement).toBe(deny);
  expect(press(deny, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(allow);
  expect(press(allow, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(deny);
  expect(confirm).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it("owns Escape once without reaching launcher window handlers or confirming", () => {
  const launcher = vi.fn(); window.addEventListener("keydown", launcher);
  try {
    expect(press(buttons()[0], "Escape").defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled(); expect(launcher).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", launcher); }
});

it("does not dismiss a confirmation for composing Escape on either node or window", () => {
  press(buttons()[0], "Escape", { isComposing: true });
  press(window, "Escape", { keyCode: 229 });
  expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it("restores the connected trigger after unmount and releases the focus listener", async () => {
  await unmount(view!); view = undefined; await tick();
  expect(document.activeElement).toBe(previous);
  const another = document.createElement("button"); document.body.append(another); another.focus();
  expect(document.activeElement).toBe(another);
});

it("does not steal focus from a permission dialog that replaces confirmation", async () => {
  const next = document.createElement("section"); next.dataset.permissionDialog = "";
  next.innerHTML = '<button id="permission">拒绝</button>'; document.body.append(next);
  await unmount(view!); view = undefined; next.querySelector<HTMLButtonElement>("button")!.focus(); await tick();
  expect(document.activeElement?.id).toBe("permission");
});

async function addRealPermission() {
  const target = document.createElement("div"); document.body.append(target);
  const backend = createPermissionHarnessBackend();
  permissionView = mount(PermissionPromptHost, { target, props: { invoke: backend.invoke, listen: backend.listen } });
  await tick(); backend.add("coexisting", true);
  await vi.waitFor(() => expect(document.querySelector("[data-permission-dialog]")).not.toBeNull());
  return backend;
}

it("gives the app-global permission ownership and resumes confirmation after the permission closes", async () => {
  const backend = await addRealPermission(), [deny] = buttons();
  const permissionDeny = document.querySelector<HTMLElement>("[data-permission-deny]")!;
  expect(document.activeElement).toBe(permissionDeny);
  deny.focus(); expect(document.activeElement).toBe(permissionDeny);
  press(permissionDeny, "Escape");
  await vi.waitFor(() => expect(document.querySelector("[data-permission-dialog]")).toBeNull());
  expect(backend.calls.some(call => call.command === "dismiss_pending_agent_request")).toBe(true);
  expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(deny);
  press(deny, "Escape"); expect(cancel).toHaveBeenCalledOnce();
  await unmount(view!); view = undefined; await tick();
  expect(document.activeElement).toBe(previous);
});

it("preserves confirmation ownership when a pending permission is externally cancelled", async () => {
  const backend = await addRealPermission();
  expect(document.activeElement).toBe(document.querySelector("[data-permission-deny]"));
  backend.cancel("coexisting");
  await vi.waitFor(() => expect(document.querySelector("[data-permission-dialog]")).toBeNull());
  expect(document.activeElement).toBe(buttons()[0]);
  expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it("also keeps the global permission on top when confirmation mounts second", async () => {
  await unmount(view!); view = undefined;
  const backend = await addRealPermission();
  view = mount(SettingsConfirmDialog, { target: document.querySelector("#target")!, props: {
    title: "确认安装", message: "确认当前发布版", oncancel: cancel, onconfirm: confirm,
  } });
  await tick(); expect(document.activeElement).toBe(document.querySelector("[data-permission-deny]"));
  backend.cancel("coexisting");
  await vi.waitFor(() => expect(document.querySelector("[data-permission-dialog]")).toBeNull());
  expect(document.activeElement).toBe(buttons()[0]);
  await unmount(view!); view = undefined; await tick(); expect(document.activeElement).toBe(previous);
});
