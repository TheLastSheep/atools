import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { attachLiveMarkdownPage, type LiveMarkdownNetworkReport } from "./page-fixture";

type Controls = ReturnType<typeof attachLiveMarkdownPage>;

export async function openFileThroughUi(controls: Controls) {
  await controls.wait("!!document.querySelector('.ty-top-menubar button.ty-menu-trigger')", "original File menu");
  await controls.clickText("button.ty-menu-trigger", "文件");
  await controls.clickTextContaining("button.ty-menu-option", "打开文件...");
}

export async function waitForEditor(controls: Controls) {
  await controls.wait("!!(document.querySelector('.typora-workbench')&&document.querySelector('#write .cm-content[contenteditable=true]'))", "original Live Markdown React editor");
  await controls.wait("document.querySelector('#write .cm-content[contenteditable=true]').innerText.length>0", "file opened by original feature entry");
  const meta = await controls.evaluate("window.__atoolsLiveMarkdownFixture");
  const rejectedIpc = meta?.rejectedIpc ?? [];
  expect(rejectedIpc).toEqual([]);
  const windowMetadata = meta?.windowMetadata ?? [];
  return { windowMetadata, rejectedIpc, fixtureMetadataAvailable: Boolean(meta),
    heightNotificationObservedCount: windowMetadata.length, heightDeliveryVerified: false };
}

export async function setAutoSaveThroughUi(controls: Controls, enabled: boolean) {
  await controls.clickText("button.ty-menu-trigger", "文件");
  await controls.clickTextContaining("button.ty-menu-option", "偏好设置...");
  await controls.wait("!!document.querySelector('#ty-preferences')", "original Preferences dialog");
  await controls.clickText("button.ty-pref-nav-btn", "编辑器 (Editor)");
  await controls.wait("document.querySelector('#ty-preferences input[type=checkbox]')?.checked===true", "default autoSave preference");
  await controls.click("#ty-preferences input[type=checkbox]");
  await controls.wait(`document.querySelector('#ty-preferences input[type=checkbox]')?.checked===${JSON.stringify(enabled)}`, "updated autoSave preference");
  await controls.click("#ty-preferences .ty-preferences-header button");
  await controls.wait("!document.querySelector('#ty-preferences')", "Preferences dialog close");
}

export async function readAutoSaveThroughUi(controls: Controls) {
  await controls.clickText("button.ty-menu-trigger", "文件");
  await controls.clickTextContaining("button.ty-menu-option", "偏好设置...");
  await controls.wait("!!document.querySelector('#ty-preferences')", "reopened Preferences dialog");
  await controls.clickText("button.ty-pref-nav-btn", "编辑器 (Editor)");
  await controls.wait("document.querySelector('#ty-preferences input[type=checkbox]')", "reopened Editor settings");
  const enabled = await controls.evaluate("document.querySelector('#ty-preferences input[type=checkbox]')?.checked");
  await controls.click("#ty-preferences .ty-preferences-header button");
  await controls.wait("!document.querySelector('#ty-preferences')", "Preferences dialog close");
  return enabled;
}

export async function switchView(controls: Controls, mode: "live" | "source") {
  const source = "#typora-source textarea.ty-source-textarea";
  if (mode === "source") {
    if (await controls.evaluate(`!!document.querySelector(${JSON.stringify(source)})`)) return;
    await controls.click("[data-testid=top-viewmode-cycle-btn]");
    await controls.wait(`!!document.querySelector(${JSON.stringify(source)})`, "source view after original top view-mode button");
  } else {
    if (await controls.evaluate("!!document.querySelector('#write .cm-content[contenteditable=true]')")) return;
    await controls.click("[data-testid=footer-viewmode-btn]");
    await controls.clickTextContaining(".ty-footer-popover-item", "实时预览 (所见即所得)");
    await controls.wait("!!document.querySelector('#write .cm-content[contenteditable=true]')", "live preview after original footer view-mode menu");
  }
}

export async function sourceText(controls: Controls) {
  return controls.evaluate("document.querySelector('#typora-source textarea.ty-source-textarea')?.value");
}

export async function saveFromToolbar(controls: Controls) {
  await controls.click("button[title='保存当前文档 (Cmd+S)']");
}

export async function saveAsThroughUi(controls: Controls) {
  await controls.clickText("button.ty-menu-trigger", "文件");
  await controls.clickTextContaining("button.ty-menu-option", "另存为...");
}

export async function waitForExactFile(path: string, expected: string) {
  const deadline = Date.now() + 15_000;
  let last = "";
  while (Date.now() < deadline) {
    try { last = await readFile(path, "utf8"); if (last === expected) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(last).toBe(expected);
}

export async function takeScreenshot(controls: Controls, root: string, name: string) {
  return controls.screenshot(join(root, name));
}

export async function assertNodeFallbackBoundary(snapshot: Record<string, any>) {
  expect(snapshot.nativeTextPort?.handled).toBe(false);
  expect(snapshot.nativeTextPort?.rustNativeAcceptance).toBe(false);
  expect(snapshot.nativeTextPort?.implementation).toBe("hosted-Node-fallback");
  expect(snapshot.nativeTextPort?.readRequests).toBeGreaterThan(0);
  expect(snapshot.nativeTextPort?.writeRequests).toBeGreaterThan(0);
  expect(snapshot.rpcRequests).toBeGreaterThan(0);
  expect(snapshot.nodeModules).toContain("node:fs");
  expect(snapshot.denials?.childProcess).toBe(0);
  expect(snapshot.denials?.externalNetwork).toBe(0);
}

export async function verifyNativeFallbackPorts(controls: Controls, readPath: string, writePath: string, expected: string) {
  const expression = `(()=>{
    var nativeFs=window.__atoolsNodeModuleRequire,fs=window.require('node:fs');
    var read=nativeFs.readTextPath(${JSON.stringify(readPath)});
    var nodeRead=fs.readFileSync(${JSON.stringify(readPath)},'utf8');
    var write=nativeFs.writeTextPath(${JSON.stringify(writePath)},${JSON.stringify(expected)});
    if(!read||read.handled!==false||!write||write.handled!==false)throw new Error('Native text fixture ports must explicitly return handled:false');
    fs.writeFileSync(${JSON.stringify(writePath)},${JSON.stringify(expected)},'utf8');
    return {readHandled:read.handled,writeHandled:write.handled,nodeRead:nodeRead};
  })()`;
  const result = await controls.evaluate(expression);
  expect(result).toEqual({ readHandled: false, writeHandled: false, nodeRead: expected });
  return { ...result, nativePorts: "handled:false; subsequent real Node fs operation used only as a separate bridge boundary probe" };
}

export function assertOpenDialog(dialogs: Array<Record<string, any>>, expectedPath: string) {
  const dialog = dialogs.find(value => value.method === "showOpenDialog");
  expect(dialog).toMatchObject({ method: "showOpenDialog", resultPath: expectedPath,
    options: { title: "打开 Markdown 文档", properties: ["openFile"] } });
  return dialog;
}

export function assertBrowserPageReport(report: LiveMarkdownNetworkReport) {
  expect(report.editorDocuments).toBe(1);
  expect(report.denied).toEqual([]);
  expect(report.failures).toEqual([]);
  expect(report.javascriptErrors).toEqual([]);
  expect(report.dialogs).toEqual([]);
  expect(report.pinsServed.map(pin => pin.path)).toContain("assets/index-CTaIDxc4.js");
  expect(report.pinsServed.map(pin => pin.path)).toContain("assets/index-C2N-317C.css");
  expect(report.pinsServed.every(pin => ["assets/index-CTaIDxc4.js", "assets/index-C2N-317C.css", "logo.svg"].includes(pin.path))).toBe(true);
  expect(report.allowed.every(request => ["bridge:node", "bridge:data", "bridge:saveDialog", "bridge:openDialog"].includes(request.route))).toBe(true);
}
