import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url).pathname;
const origin = "http://127.0.0.1:1452";
const output = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
let server; let chrome; let page;
const consoleIssues = [];
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function settle(expression = "") {
  return evaluate(`(async()=>{${expression}; await Promise.resolve(); window.__permissionRuntime.flushSync(); await window.__permissionRuntime.tick(); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
}
async function snapshot() {
  return evaluate(`(()=>{
    const dialog=document.querySelector('[role="dialog"]');
    return { dialogs:document.querySelectorAll('[role="dialog"]').length,
      title:dialog?.querySelector('h2')?.textContent, status:dialog?.querySelector('[role="status"]')?.textContent,
      displayedTime:dialog?.querySelector('.request-time')?.textContent, fullTime:dialog?.querySelector('.request-time')?.title,
      busy:dialog?.getAttribute('aria-busy'), error:dialog?.querySelector('[role="alert"]')?.textContent || '',
      buttons:[...dialog?.querySelectorAll('button')||[]].map(button=>({label:button.textContent,disabled:button.disabled})),
      activeText:document.activeElement?.textContent, activeId:document.activeElement?.id,
      focusInside:!!dialog?.contains(document.activeElement), escaped:window.__permissionEscaped,
      pending:[...window.__permissionBackend.requests.keys()],
      calls:window.__permissionBackend.calls.map(call=>({command:call.command,requestId:call.args?.requestId,runId:call.args?.runId})),
    };
  })()`);
}
async function click(label) {
  await settle(`[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
}
async function key(key, modifiers = 0) {
  const codes = { Tab: 9, Escape: 27 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
  await settle();
}
async function screenshot(name) {
  const capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL(name, output), Buffer.from(capture.data, "base64"));
}

try {
  await mkdir(output, { recursive: true });
  server = await launchViteServer({ cwd: root, port: 1452, probeUrl: origin });
  const source = await (await fetch(`${origin}/src/main.ts`)).text();
  const runtimePath = source.match(/import\s*\{\s*mount\s*\}\s*from\s*["']([^"']+)["']/)?.[1];
  assert.ok(runtimePath);
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["warning", "error", "assert"].includes(type)) consoleIssues.push(`${type}: ${formatConsoleArgs(args)}`);
  });
  page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => consoleIssues.push(`exception: ${exceptionDetails.exception?.description || exceptionDetails.text}`));
  await page.send("Runtime.enable"); await page.send("Page.enable");
  const browserVersion = await page.send("Browser.getVersion");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 740, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: origin }); await loaded;
  await evaluate(`(async()=>{
    const app=await import('/src/main.ts'); const runtime=await import(${JSON.stringify(runtimePath)});
    await runtime.unmount(app.default); window.__permissionRuntime=runtime;
    const Harness=(await import('/tests/components/PermissionPromptBrowserHarness.svelte')).default;
    document.documentElement.dataset.atoolsTheme='light';
    document.body.style.cssText='background:#e8ecf1;min-height:740px;overflow:auto';
    document.getElementById('app').style.cssText='width:100%;height:740px;overflow:hidden';
    window.__permissionFixture=runtime.mount(Harness,{target:document.getElementById('app'),props:{onready:backend=>window.__permissionBackend=backend}});
    runtime.flushSync(); await runtime.tick();
    window.__permissionEscaped=0;
    window.addEventListener('keydown',event=>{if(event.key==='Escape')window.__permissionEscaped++});
  })()`);
  await settle("document.getElementById('launcher-search').focus()");
  consoleIssues.length = 0;
  await settle("window.__permissionBackend.add('alpha',true); window.__permissionBackend.add('beta')");
  const queued = await snapshot();
  assert.equal(queued.dialogs, 1); assert.equal(queued.title, "示例插件 · alpha 请求访问本机");
  assert.match(queued.displayedTime, /^\d{2}:\d{2}$/); assert.equal(queued.fullTime, "2026-10-15T12:00:00Z");
  assert.match(queued.status, /共 2 个请求/); assert.equal(queued.activeText, "拒绝");
  await screenshot("permission-queue.png");
  await settle("[...document.querySelectorAll('[role=dialog] button')].at(-1).focus()");
  await key("Tab"); const forward = await snapshot(); assert.equal(forward.activeText, "技术详情");
  await key("Tab", 8); const backward = await snapshot(); assert.equal(backward.activeText, "允许并记住");
  await settle("document.getElementById('launcher-search').focus()");
  assert.equal((await snapshot()).focusInside, true, "Programmatic background focus must remain inside the modal");
  await settle("window.__permissionBackend.failNext('grant_agent_tool')");
  await click("允许并记住");
  const failedGrant = await snapshot();
  assert.match(failedGrant.error, /数据库暂时繁忙/); assert.ok(failedGrant.buttons.every(button => !button.disabled));
  await screenshot("permission-error.png");
  await settle("window.__permissionRelease=window.__permissionBackend.hold('call_agent_tool')");
  await click("允许一次"); const busy = await snapshot();
  assert.equal(busy.busy, "true"); assert.ok(busy.buttons.every(button => button.disabled));
  await key("Escape"); const busyEscape = await snapshot();
  assert.equal(busyEscape.escaped, 0);
  assert.equal(busyEscape.calls.filter(call => call.command === "dismiss_pending_agent_request").length, 0);
  await screenshot("permission-busy.png");
  await settle("window.__permissionBackend.cancel('alpha')"); const cancelled = await snapshot();
  assert.match(cancelled.title, /beta/); assert.equal(cancelled.busy, "false"); assert.equal(cancelled.error, "");
  await settle("window.__permissionRelease()"); const late = await snapshot();
  assert.match(late.title, /beta/); assert.equal(late.error, ""); assert.equal(late.busy, "false");
  await settle("window.__permissionBackend.cancel('beta')"); const closed = await snapshot();
  assert.equal(closed.dialogs, 0); assert.equal(closed.activeId, "launcher-search");
  const idleCalls = closed.calls.length;
  await settle("for(let index=0;index<50;index++)window.__permissionBackend.emit('task-run-updated','unrelated-'+index)");
  assert.equal((await snapshot()).calls.length, idleCalls, "Unrelated task events must not create polling or refresh traffic");
  await settle("window.__permissionBackend.add('gamma')"); await key("Escape");
  const denied = await snapshot(); assert.equal(denied.dialogs, 0); assert.equal(denied.escaped, 0);
  assert.ok(denied.calls.some(call => call.command === "dismiss_pending_agent_request" && call.requestId === "gamma"));
  await key("Escape"); assert.equal((await snapshot()).escaped, 1, "The background keyboard handler must still work after the modal closes");
  await evaluate("window.__permissionRuntime.unmount(window.__permissionFixture)");
  assert.equal(await evaluate("window.__permissionBackend.listenerCount()"), 0);
  assert.deepEqual(consoleIssues, []);
  const report = { status: "passed", environment: "Headless Chromium + Vite preview, actual PermissionPromptHost/PermissionConfirmDialog; simulated IPC/task events, not native Tauri authorization", browserVersion,
    queued, forward, backward, failedGrant, busy, busyEscape, cancelled, late, closed, denied, idleCalls, consoleIssues,
    screenshots: ["permission-queue.png", "permission-error.png", "permission-busy.png"] };
  await writeFile(new URL("permission-dialog.json", output), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify({ ok: true, output: output.pathname, mockedIPC: true, screenshots: report.screenshots }));
} finally {
  await page?.close?.();
  await Promise.allSettled([chrome?.close?.(), server?.close?.()]);
}
