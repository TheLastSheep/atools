import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { CdpClient, createPageWebSocketUrl, delay, launchChrome, launchViteServer } from "./chrome-cdp-smoke-utils.mjs";

const output = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
let server, chrome, page;
const issues = [];
const requests = [];
const checks = [];
async function evaluate(expression) {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(30);
  }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function typeQuery(value) {
  await evaluate(`(() => { const input = document.querySelector('[data-atools-search-input]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
  await delay(40);
}
async function key(key, code, virtualKey) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey });
  await delay(25);
}
async function capture(name) {
  const bounds = await evaluate(`(() => { const b=document.querySelector('.shell-frame').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}; })()`);
  const shot = await page.send("Page.captureScreenshot", { format: "png", clip: bounds });
  await writeFile(new URL(name, output), Buffer.from(shot.data, "base64"));
}
try {
  await mkdir(output, { recursive: true });
  server = await launchViteServer({ port: 1450, probeUrl: "http://127.0.0.1:1450/" });
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  page.on("Network.requestWillBeSent", (event) => requests.push(event.request.url));
  page.on("Runtime.exceptionThrown", (event) => issues.push(event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", (event) => {
    if (["error", "warning"].includes(event.type)) issues.push(event.args.map((arg) => arg.value ?? arg.description).join(" "));
  });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 560, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: "http://127.0.0.1:1450/" });
  await waitFor(`document.querySelector('nav[aria-label="常用入口"] button')`);
  await delay(1000);
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.dataset.atoolsTheme = ${JSON.stringify(theme)}`);
    await delay(180);
    await capture(`home-${theme}.png`);
    await waitFor(`document.querySelector('nav[aria-label="常用入口"]') !== null`);
    const geometry = await evaluate(`(() => {const nav=document.querySelector('nav[aria-label="常用入口"]');const box=nav.getBoundingClientRect();const frame=document.querySelector('.shell-frame').getBoundingClientRect();return {buttons:nav.querySelectorAll('button').length,overflow:document.documentElement.scrollWidth>innerWidth,navVisible:box.bottom<=frame.bottom};})()`);
    assert.deepEqual(geometry, { buttons: 4, overflow: false, navVisible: true });
  }
  assert.ok(!requests.some((url) => url.includes("/src/components/SystemPanel.svelte") || url.includes("/src/components/PluginPanel.svelte")), "Home must not eagerly request settings or plugin host code");
  checks.push("Home defers settings and plugin host modules until navigation");
  checks.push("760px light/dark: compact navigation visible without horizontal overflow");
  await typeQuery(">");
  await waitFor(`document.querySelectorAll('[role="option"]').length === 5`);
  const first = await evaluate(`document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`);
  await key("ArrowDown", "ArrowDown", 40);
  const second = await evaluate(`document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`);
  assert.notEqual(first, second);
  assert.equal(await evaluate(`document.querySelector('[aria-selected="true"]').id`), second);
  checks.push("ArrowDown keeps combobox and selected result in agreement");
  await capture("search-dark.png");

  await evaluate(`(() => {
    const input=document.querySelector('[role="combobox"]');
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
    input.value='she'; input.dispatchEvent(new InputEvent('input', {bubbles:true,isComposing:true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,isComposing:true,cancelable:true}));
  })()`);
  await delay(50);
  assert.equal(await evaluate(`document.querySelectorAll('[role="option"]').length`), 5);
  assert.equal(await evaluate(`document.querySelector('[role="combobox"]').value`), "she");
  await evaluate(`(() => {const input=document.querySelector('[role="combobox"]');input.value='设置';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'设置'}));})()`);
  await waitFor(`document.querySelector('[role="option"]')?.textContent.includes('设置')`);
  assert.ok(await evaluate(`document.querySelector('[role="combobox"]') !== null`));
  checks.push("IME preedit does not search or activate; completed Chinese text searches normally");

  await typeQuery("");
  await waitFor(`document.querySelector('nav[aria-label="常用入口"]') !== null`);
  const prevented = await evaluate(`(() => {const b=document.querySelector('nav button');b.focus();const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});b.dispatchEvent(e);return e.defaultPrevented;})()`);
  assert.equal(prevented, false);
  checks.push("Home navigation retains native Tab behavior");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 560, deviceScaleFactor: 1, mobile: false });
  await capture("home-compact.png");
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
  checks.push("480px: no horizontal overflow");
  await evaluate(`Array.from(document.querySelectorAll('nav button')).find((button) => button.textContent.includes('插件管理')).click()`);
  await waitFor(`(() => {
    const activeMenu = document.querySelector('.settings-sidebar .menu-item.active')?.textContent.trim();
    const inventory = document.querySelector('section.inventory[aria-label="已安装插件"]');
    return activeMenu === '已安装插件' && Boolean(inventory?.querySelector('.plugin-list'));
  })()`);
  assert.ok(await evaluate(`Boolean(document.querySelector('section.inventory[aria-label="已安装插件"] .plugin-list'))`),
    "The installed-plugin management view must render its accessible inventory list");
  assert.ok(requests.some((url) => url.includes("/src/components/SystemPanel.svelte")));
  assert.ok(!requests.some((url) => url.includes("/src/components/PluginPanel.svelte")));
  checks.push("Plugin management loads on demand and remains navigable");
  assert.deepEqual(issues, []);
  const report = { status: "passed", scope: "Chromium web preview; no native IPC, hotkey, RSS or competitor performance claim", checks, consoleIssues: issues };
  await writeFile(new URL("browser.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await page?.close();
  await chrome?.close();
  await server?.close();
}
