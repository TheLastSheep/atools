import assert from "node:assert/strict";
import test from "node:test";
import { originalBrowserControls } from "./original-plugin-browser-cdp.mjs";

function controlsWithCalls() {
  const calls = [];
  const page = {
    remaining: () => 1000,
    on: () => {},
    async send(method, payload) { calls.push([method, payload]); },
  };
  return { controls: originalBrowserControls(page, { inputs: [] }), calls };
}

test("plain Enter sends CR text on keyDown and no additional key event", async () => {
  const { controls, calls } = controlsWithCalls();

  await controls.key("Enter", "Enter", 13);

  assert.deepEqual(calls, [
    ["Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
      unmodifiedText: "\r",
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
    }],
  ]);
});

test("Tab, modified Enter, and Meta+A keep their existing CDP payloads", async () => {
  const { controls, calls } = controlsWithCalls();

  await controls.key("Enter", "Enter", 13, 8);
  await controls.key("Tab", "Tab", 9);
  await controls.key("a", "KeyA", 65, 4);

  assert.deepEqual(calls, [
    ["Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8,
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8,
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 0,
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 0,
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4,
      commands: ["selectAll"],
    }],
    ["Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4,
    }],
  ]);
});
