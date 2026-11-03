import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { CdpClient } from "../../scripts/chrome-cdp-smoke-utils.mjs";

type Report = Record<string, any>;

export async function runPluginActionsMenuScenario(
  page: CdpClient,
  outputRoot: string,
  runId: string,
  report: Report,
) {
  report.menuAcceptance = { status: "running", passed: false, route: "menu" };
  report.menuInteractions = [];

  for (const width of [320, 480, 760]) {
    for (const theme of ["light", "dark"] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width, height: 900, deviceScaleFactor: 1, mobile: false,
      }, { timeoutMs: 5000 });
      await evaluate(page, `document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
      await closeMenuIfOpen(page);
      const closed = await measureMenuGeometry(page, width, theme, false);
      assertComfortableNavigation(closed);
      report.geometry.push({ ...closed, route: "menu", state: "closed" });
      await saveScreenshot(page, outputRoot, runId, report, width, theme, "closed");

      await clickSelector(page, 'button[aria-label="更多插件操作"]');
      await waitFor(page, `document.querySelector('[role="menu"][aria-label="插件操作"]')`);
      const opened = await measureMenuGeometry(page, width, theme, true);
      assertComfortableNavigation(opened);
      assertMenuFits(opened);
      report.geometry.push({ ...opened, route: "menu", state: "open" });
      await saveScreenshot(page, outputRoot, runId, report, width, theme, "open");
      expect(opened.runtimeWarning).toBe(true);
      await pressKey(page, "Escape");
      await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
      expect(await evaluate<string>(page, `document.activeElement?.getAttribute('aria-label')??''`)).toBe("更多插件操作");
    }
  }

  await testDisabledAndKeyboard(page, report);
  await testSettingsToggleWithoutClosing(page, report);
  await testTabAndOutsidePointer(page, report);
  await testIframeDismissal(page, report);
  await testActionsAndRuntimeWarning(page, report);
  await testSubinputImeAndClear(page, report);

  const state = await readState(page);
  const summary = summarize(state.callbacks);
  report.callbacks = state.callbacks;
  report.callbackSummary = summary;
  expect(summary).toMatchObject({
    settings: 1,
    detach: 1,
    body: 1,
    iframeBody: 1,
    runtimeInfo: 0,
    returns: 0,
  });
  expect(summary.inputs.at(-1)).toBe("");
  expect(report.menuAcceptance.status).toBe("running");
  report.menuAcceptance = {
    status: "passed",
    passed: true,
    route: "menu",
    viewports: 6,
    screenshots: report.screenshots.filter((item: any) => item.route === "menu").length,
    behaviors: report.menuInteractions,
  };
  return report.menuAcceptance;
}

async function testDisabledAndKeyboard(page: CdpClient, report: Report) {
  const before = await readState(page);
  await openMenuByTrigger(page);
  let state = await inspectMenu(page);
  expect(state.settingsDisabled).toBe(true);
  expect(state.activeItem).toBe("分离");
  await clickSelector(page, '[role="menuitem"]:disabled');
  state = await inspectMenu(page);
  expect(state.expanded).toBe(true);
  expect((await readState(page)).callbacks).toEqual(before.callbacks);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    await pressKey(page, key);
    expect((await inspectMenu(page)).activeItem).toBe("分离");
  }
  await pressKey(page, "Escape");
  state = await inspectMenu(page);
  expect(state.expanded).toBe(false);
  expect(state.triggerFocused).toBe(true);

  await focusTrigger(page);
  await pressKey(page, "ArrowDown");
  state = await inspectMenu(page);
  expect(state.expanded).toBe(true);
  expect(state.activeItem).toBe("分离");
  await pressKey(page, "Escape");
  await focusTrigger(page);
  await pressKey(page, "ArrowUp");
  state = await inspectMenu(page);
  expect(state.activeItem).toBe("分离");
  await pressKey(page, "Escape");
  record(report, "disabled-menuitem-is-not-activated-or-focused; arrows-home-end-skip-it; escape-restores-trigger; trigger-arrows-open-at-enabled-edge");
}

async function testSettingsToggleWithoutClosing(page: CdpClient, report: Report) {
  await openMenuByTrigger(page);
  await evaluate(page, `window.pluginActionsBrowserFixture.setSettingsAvailable(true)`);
  await waitFor(page, `!document.querySelector('[role="menuitem"]')?.disabled`);
  let state = await inspectMenu(page);
  expect(state.expanded).toBe(true);
  expect(state.settingsDisabled).toBe(false);

  await pressKey(page, "ArrowUp");
  expect((await inspectMenu(page)).activeItem).toBe("设置");
  await pressKey(page, "ArrowDown");
  expect((await inspectMenu(page)).activeItem).toBe("分离");
  await pressKey(page, "Home");
  expect((await inspectMenu(page)).activeItem).toBe("设置");
  await pressKey(page, "End");
  expect((await inspectMenu(page)).activeItem).toBe("分离");
  await pressKey(page, "ArrowDown");
  expect((await inspectMenu(page)).activeItem).toBe("设置");

  await evaluate(page, `window.pluginActionsBrowserFixture.setSettingsAvailable(false)`);
  await waitFor(page, `document.querySelector('[role="menuitem"]')?.disabled===true`);
  state = await inspectMenu(page);
  expect(state.expanded).toBe(true);
  expect(state.settingsDisabled).toBe(true);
  await evaluate(page, `window.pluginActionsBrowserFixture.setSettingsAvailable(true)`);
  await waitFor(page, `document.querySelector('[role="menuitem"]')?.disabled===false`);
  state = await inspectMenu(page);
  expect(state.expanded).toBe(true);
  expect(state.settingsDisabled).toBe(false);
  await pressKey(page, "Escape");

  await focusTrigger(page);
  await pressKey(page, "ArrowDown");
  expect((await inspectMenu(page)).activeItem).toBe("设置");
  await pressKey(page, "Escape");
  await focusTrigger(page);
  await pressKey(page, "ArrowUp");
  expect((await inspectMenu(page)).activeItem).toBe("分离");
  await pressKey(page, "Escape");
  record(report, "same-title-settings-availability-updates-native-disabled-state-without-dismissing-menu");
}

async function testTabAndOutsidePointer(page: CdpClient, report: Report) {
  await page.send("Page.bringToFront", {}, { timeoutMs: 5000 });
  await openMenuByTrigger(page);
  const beforeTab = await inspectFocus(page);
  await pressKey(page, "Tab");
  await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
  const afterTab = await inspectFocus(page);
  expect(afterTab.inMenu).toBe(false);
  expect(afterTab.hasFocus).toBe(true);
  expect(afterTab.runtimeInfo).toBe(true);
  report.menuInteractions.push({ behavior: "Tab leaves menu on next navigation control", before: beforeTab, after: afterTab });

  await openMenuByTrigger(page);
  const beforeShiftTab = await inspectFocus(page);
  const callbackCount = (await readState(page)).callbacks.length;
  await pressKey(page, "Tab", true);
  await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
  const afterShiftTab = await inspectFocus(page);
  expect(afterShiftTab.inMenu).toBe(false);
  expect(afterShiftTab.hasFocus).toBe(true);
  expect(afterShiftTab.subInput).toBe(true);
  expect((await readState(page)).callbacks).toHaveLength(callbackCount);
  report.menuInteractions.push({ behavior: "Shift+Tab leaves menu on subinput without dispatching an action", before: beforeShiftTab, after: afterShiftTab });

  await openMenuByTrigger(page);
  await clickSelector(page, "#fixture-body-action");
  await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
  expect(await evaluate<string>(page, `document.activeElement?.id??''`)).toBe("fixture-body-action");
  record(report, "outside-pointer-closes-menu-and-keeps-body-control-focused");
}

async function testIframeDismissal(page: CdpClient, report: Report) {
  await openMenuByTrigger(page);
  const frameButton = await evaluate<{ x: number; y: number; width: number; height: number } | null>(page, `(()=>{
    const frame=document.querySelector('#fixture-plugin-frame');if(!frame?.contentWindow)return null;
    const outer=frame.getBoundingClientRect();
    const inner=frame.contentDocument?.querySelector('#fixture-iframe-action')?.getBoundingClientRect();
    return inner?{x:outer.x+inner.x,y:outer.y+inner.y,width:inner.width,height:inner.height}:null;
  })()`);
  assert.ok(frameButton && frameButton.width > 0 && frameButton.height > 0, "fixed same-origin iframe action is rendered");
  await clickPoint(page, frameButton.x + frameButton.width / 2, frameButton.y + frameButton.height / 2);
  await waitFor(page, `window.pluginActionsBrowserFixture.getState().callbacks.some(item=>item.type==='iframe-body')`);
  await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
  expect(await evaluate<boolean>(page, `Boolean(document.activeElement?.closest('[role="menu"]'))`)).toBe(false);
  record(report, "click-inside-plugin-iframe-closes-menu-and-remains-actionable");
}

async function testActionsAndRuntimeWarning(page: CdpClient, report: Report) {
  const warning = await evaluate<boolean>(page, `(()=>{const button=document.querySelector('.runtime-info-action');return Boolean(button?.classList.contains('has-warning')&&button.getAttribute('aria-label')==='运行信息，有警告')})()`);
  expect(warning).toBe(true);
  await openMenuByTrigger(page);
  expect(await evaluate<boolean>(page, `Boolean(document.querySelector('.runtime-info-action.has-warning'))`)).toBe(true);
  await clickMenuItem(page, "设置");
  await waitFor(page, `window.pluginActionsBrowserFixture.getState().callbacks.filter(item=>item.type==='action'&&item.actionId==='settings').length===1`);
  expect(await evaluate<string>(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')??''`)).toBe("false");

  await openMenuByTrigger(page);
  const detach = await evaluate<boolean>(page, `Boolean([...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()==='分离'&&!item.disabled))`);
  expect(detach).toBe(true);
  await clickMenuItem(page, "分离");
  await waitFor(page, `window.pluginActionsBrowserFixture.getState().callbacks.filter(item=>item.type==='action'&&item.actionId==='detach').length===1`);
  record(report, "settings-and-detach-menu-actions-dispatch-once;-runtime-warning-stays-visible");
}

async function testSubinputImeAndClear(page: CdpClient, report: Report) {
  const before = await readState(page);
  await clickSelector(page, ".sub-input");
  await page.send("Input.imeSetComposition", {
    text: "Harris",
    selectionStart: 6,
    selectionEnd: 6,
  }, { timeoutMs: 5000 });
  await waitFor(page, `document.querySelector('.sub-input')?.dataset.atoolsComposing==='true'`);
  expect((await readState(page)).callbacks).toEqual(before.callbacks);
  await page.send("Input.imeSetComposition", {
    text: "Harris 文档",
    selectionStart: 9,
    selectionEnd: 9,
  }, { timeoutMs: 5000 });
  await page.send("Input.insertText", { text: "Harris 文档" }, { timeoutMs: 5000 });
  await waitFor(page, `document.querySelector('.sub-input')?.dataset.atoolsComposing!=='true'`);
  await waitFor(page, `document.querySelector('.sub-input')?.value.length>0`);
  await clickSelector(page, ".sub-input-clear");
  await waitFor(page, `document.querySelector('.sub-input')?.value===''`);
  expect(await evaluate<string>(page, `document.activeElement?.className??''`)).toContain("sub-input");
  const inputCallbacks = (await readState(page)).callbacks
    .filter((item: any) => item.type === "input").slice(before.callbacks.filter((item: any) => item.type === "input").length);
  expect(inputCallbacks.length).toBeGreaterThanOrEqual(1);
  expect(inputCallbacks.at(-1)?.value).toBe("");
  record(report, "IME-composition-suppresses-intermediate-search; committed-text-clears-and-returns-focus-to-subinput");
}

async function measureMenuGeometry(page: CdpClient, width: number, theme: "light" | "dark", expectedOpen: boolean) {
  const geometry = await evaluate<Record<string, any>>(page, `(()=>{
    const rect=(e)=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const nav=document.querySelector('.plugin-navigation');
    const input=document.querySelector('.sub-input');
    const menu=document.querySelector('[role="menu"]');
    const trigger=document.querySelector('[aria-label="更多插件操作"]');
    const body=document.querySelector('[data-plugin-body]');
    return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
      navigation:rect(nav),input:rect(input),menu:rect(menu),items:[...(menu?.querySelectorAll('[role="menuitem"]')??[])].map(rect),
      body:rect(body),bodyBelowNavigation:Boolean(nav&&body&&body.getBoundingClientRect().top>=nav.getBoundingClientRect().bottom-1),
      triggerExpanded:trigger?.getAttribute('aria-expanded')==='true',runtimeWarning:Boolean(document.querySelector('.runtime-info-action.has-warning'))};
  })()`);
  expect(geometry.triggerExpanded).toBe(expectedOpen);
  return { width, theme, expectedOpen, navigationHeight: geometry.navigation?.height ?? null,
    inputWidth: geometry.input?.width ?? null, documentWidth: geometry.documentWidth,
    horizontalOverflow: geometry.documentWidth > geometry.viewport.width,
    menu: geometry.menu, menuItems: geometry.items, bodyBelowNavigation: geometry.bodyBelowNavigation,
    runtimeWarning: geometry.runtimeWarning, viewport: geometry.viewport };
}

function assertComfortableNavigation(geometry: Record<string, any>) {
  expect(geometry.navigationHeight).toBeLessThanOrEqual(57);
  expect(geometry.inputWidth).toBeGreaterThanOrEqual(80);
  expect(geometry.horizontalOverflow).toBe(false);
  expect(geometry.bodyBelowNavigation).toBe(true);
}

function assertMenuFits(geometry: Record<string, any>) {
  assert.ok(geometry.menu, "menu popup is visible");
  expect(geometry.menu.left).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.top).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  expect(geometry.menuItems).toHaveLength(2);
  for (const item of geometry.menuItems) {
    expect(item.left).toBeGreaterThanOrEqual(geometry.menu.left);
    expect(item.right).toBeLessThanOrEqual(geometry.menu.right);
    expect(item.top).toBeGreaterThanOrEqual(geometry.menu.top);
    expect(item.bottom).toBeLessThanOrEqual(geometry.menu.bottom);
  }
}

async function saveScreenshot(page: CdpClient, outputRoot: string, runId: string, report: Report, width: number, theme: string, menu: "open" | "closed") {
  const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, { timeoutMs: 5000 });
  const path = join(outputRoot, `${runId}-menu-${width}-${theme}-${menu}.png`);
  await writeFile(path, Buffer.from(screenshot.data, "base64"), { flag: "wx", mode: 0o600 });
  report.screenshots.push({ route: "menu", width, theme, menu, path, bytes: Buffer.byteLength(screenshot.data, "base64") });
}

async function clickSelector(page: CdpClient, selector: string) {
  const bounds = await evaluate<{ x: number; y: number; width: number; height: number } | null>(page, `(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;
    const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
  })()`);
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `visible pointer target: ${selector}`);
  await clickPoint(page, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function clickMenuItem(page: CdpClient, label: string) {
  const bounds = await evaluate<{ x: number; y: number; width: number; height: number } | null>(page, `(()=>{
    const item=[...document.querySelectorAll('[role="menuitem"]')].find(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.disabled);
    if(!item)return null;const r=item.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
  })()`);
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `enabled menu item is visible: ${label}`);
  await clickPoint(page, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function clickPoint(page: CdpClient, x: number, y: number) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { timeoutMs: 5000 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
}

async function pressKey(page: CdpClient, key: string, shift = false) {
  const virtualCodes: Record<string, number> = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Tab: 9 };
  const code = virtualCodes[key];
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code: key, ...(shift ? { modifiers: 8 } : {}), ...(code ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } : {}),
  }, { timeoutMs: 5000 });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code: key, ...(shift ? { modifiers: 8 } : {}), ...(code ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } : {}),
  }, { timeoutMs: 5000 });
}

async function openMenuByTrigger(page: CdpClient) {
  await closeMenuIfOpen(page);
  await clickSelector(page, '[aria-label="更多插件操作"]');
  await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='true'`);
  await waitFor(page, `document.querySelector('[role="menu"] [role="menuitem"]')`);
}

async function closeMenuIfOpen(page: CdpClient) {
  const expanded = await evaluate<boolean>(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='true'`);
  if (expanded) {
    await pressKey(page, "Escape");
    const stillOpen = await evaluate<boolean>(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='true'`);
    if (stillOpen) await clickSelector(page, '[aria-label="更多插件操作"]');
    await waitFor(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')==='false'`);
  }
}

async function focusTrigger(page: CdpClient) {
  await evaluate(page, `document.querySelector('[aria-label="更多插件操作"]')?.focus()`);
}

async function inspectMenu(page: CdpClient) {
  return evaluate<Record<string, any>>(page, `(()=>{
    const trigger=document.querySelector('[aria-label="更多插件操作"]');
    const menu=document.querySelector('[role="menu"][aria-label="插件操作"]');
    const items=[...(menu?.querySelectorAll('[role="menuitem"]')??[])];
    return {expanded:trigger?.getAttribute('aria-expanded')==='true',settingsDisabled:items.find(item=>item.textContent.trim()==='设置')?.disabled??null,
      activeItem:items.find(item=>item===document.activeElement)?.textContent.trim()??null,
      triggerFocused:document.activeElement===trigger};
  })()`);
}

async function inspectFocus(page: CdpClient) {
  return evaluate<Record<string, any>>(page, `(()=>{
    const active=document.activeElement;
    return {label:active?.getAttribute('aria-label')??active?.textContent?.trim()??active?.tagName??null,
      className:typeof active?.className==='string'?active.className:'',
      hasFocus:document.hasFocus(),inMenu:Boolean(active?.closest('[role="menu"]')),
      runtimeInfo:Boolean(active?.matches('.runtime-info-action')),subInput:Boolean(active?.matches('.sub-input'))};
  })()`);
}

async function readState(page: CdpClient) {
  return evaluate<Record<string, any>>(page, "window.pluginActionsBrowserFixture.getState()");
}

async function evaluate<T>(page: CdpClient, expression: string): Promise<T> {
  const response = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 5000 });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  return response.result?.value as T;
}

async function waitFor(page: CdpClient, expression: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await evaluate<boolean>(page, `Boolean(${expression})`)) return; } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

function summarize(callbacks: Array<Record<string, any>>) {
  return {
    settings: callbacks.filter(item => item.type === "action" && item.actionId === "settings").length,
    detach: callbacks.filter(item => item.type === "action" && item.actionId === "detach").length,
    body: callbacks.filter(item => item.type === "body").length,
    iframeBody: callbacks.filter(item => item.type === "iframe-body").length,
    runtimeInfo: callbacks.filter(item => item.type === "runtime-info").length,
    returns: callbacks.filter(item => item.type === "return").length,
    inputs: callbacks.filter(item => item.type === "input").map(item => item.value),
  };
}

function record(report: Report, behavior: string) {
  report.menuInteractions.push({ behavior, status: "checked" });
}
