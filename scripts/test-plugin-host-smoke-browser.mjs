import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertCheckedChecklistRow,
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
  launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";

const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const smokeUrl = "http://localhost:1420/?parity=1&pluginHostSmoke=1";

const expectedChecklistRow = "Web 预览 `?parity=1&pluginHostSmoke=1` 只验证插件宿主 UI：显示 `插件运行态预览`、运行状态/SubInput/输出结果/桥接能力 4 个状态卡、桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`、SubInput 和 output 列表，且 header/runtime/SubInput/body/output 不互相覆盖。";
const expectedTimestampOutputChecklistRow = "输入时间戳/日期后，插件输出列表可选，选中行显示 `Enter 复制`。";
const expectedOutputContextMenuChecklistRow = "插件 output 行右键会打开 `复制结果` 菜单；按 `Esc` 只关闭该菜单，不退出插件态，点击菜单项应复制当前行结果并显示既有复制反馈。";
const expectedLayoutChecklistRow = "插件运行态标题栏、subInput、iframe/output body 不互相覆盖；output layer 出现时不和 iframe 同时占位。";

async function main() {
  let appServer;
  let chrome;
  try {
    appServer = await launchViteServer();
    chrome = await launchChrome();
    const pageWebSocketUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
    const page = await CdpClient.connect(pageWebSocketUrl);
    const consoleIssues = [];
    try {
      page.on("Runtime.consoleAPICalled", (params) => {
        if (["warning", "error", "assert"].includes(params.type)) {
          consoleIssues.push(`${params.type}: ${formatConsoleArgs(params.args)}`);
        }
      });
      page.on("Runtime.exceptionThrown", (params) => {
        consoleIssues.push(`exception: ${params.exceptionDetails?.text || "Runtime exception"}`);
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          (() => {
            const clipboardShim = {
              writeText: async (value) => {
                window.__atoolsPluginOutputCopiedText = String(value);
              },
              readText: async () => window.__atoolsPluginOutputCopiedText || "",
            };
            try {
              Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboardShim });
            } catch {
              Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => clipboardShim });
            }
          })();
        `,
      });
      await page.send("Page.navigate", { url: smokeUrl });

      const state = await waitForPluginHostSmoke(page);
      assertPluginHostSmokeState(state);
      const movedState = await movePluginOutputSelectionDown(page);
      assertPluginHostSelectionMovedState(movedState);
      const outputMenuState = await openPluginOutputContextMenu(page, 1);
      assertPluginOutputContextMenuOpenState(outputMenuState);
      const escapedOutputMenuState = await closePluginOutputContextMenuWithEscape(page);
      assertPluginOutputContextMenuEscState(escapedOutputMenuState);
      const copiedOutputMenuState = await copyPluginOutputFromContextMenu(page, 1);
      assertPluginOutputContextMenuCopyState(copiedOutputMenuState);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "pluginHostSmoke Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const checklist = await readFile(checklistUrl, "utf8");
    assertCheckedChecklistRow(checklist, expectedChecklistRow);
    assertCheckedChecklistRow(checklist, expectedTimestampOutputChecklistRow);
    assertCheckedChecklistRow(checklist, expectedOutputContextMenuChecklistRow);
    assertCheckedChecklistRow(checklist, expectedLayoutChecklistRow);

    const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
    assert.equal(
      packageJson.scripts["test:plugin-host-smoke-browser"],
      "node scripts/test-plugin-host-smoke-browser.mjs",
    );
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
    ].filter(Boolean));
  }
}

function assertPluginHostSmokeState(state) {
  assert.equal(state.title, "ATools 3.0");
  assert.equal(state.pluginTitle, "插件运行态预览");
  assert.equal(state.featureCode, "pluginHostSmoke");
  assert.equal(state.pluginSource, "plugin-host-smoke");
  assert.equal(state.runtimeChipCount, 4);
  assert.deepEqual(state.runtimeChips.map((chip) => [chip.label, chip.value, chip.detail]), [
    ["运行状态", "输出层", "插件已返回可选结果"],
    ["SubInput", "已启用", "插件请求了关键字输入"],
    ["输出结果", "2 项", "方向键选择，Enter 复制"],
    ["桥接能力", "utools/ztools", "DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文"],
  ]);
  assert.equal(state.subInput.placeholder, "输入插件关键词");
  assert.equal(state.subInput.value, "time");
  assert.equal(state.outputRowCount, 2);
  assert.deepEqual(state.outputRows, [
    { title: "当前时间戳", description: "秒级输出", hint: "Enter 复制" },
    { title: "当前时间戳毫秒", description: "毫秒输出", hint: "" },
  ]);
  assert.equal(state.outputLayerCount, 1, "output smoke should render one output layer");
  assert.equal(state.hasIframeBody, false, "pluginHostSmoke=1 should validate host output UI rather than real plugin search");
  assert.equal(state.viteOverlayCount, 0);
  assert.equal(state.documentOverflows, false);
  assert.equal(state.bodyOverflows, false);
  assert.deepEqual(state.overlaps, [], "header/runtime/SubInput/body should not overlap");
  assert.equal(state.outputInsideBody, true, "output layer should stay inside the plugin body");
}

function assertPluginHostSelectionMovedState(state) {
  assert.equal(state.outputRowCount, 2);
  assert.deepEqual(state.outputRows, [
    { title: "当前时间戳", description: "秒级输出", hint: "" },
    { title: "当前时间戳毫秒", description: "毫秒输出", hint: "Enter 复制" },
  ]);
}

function assertPluginOutputContextMenuOpenState(state) {
  assert.equal(state.outputMenu.visible, true, "right-clicking an output row should open the output context menu");
  assert.equal(state.outputMenu.label, "复制结果");
  assert.equal(state.outputRows[1]?.hint, "Enter 复制", "right-clicking a row should keep that row selected");
}

function assertPluginOutputContextMenuEscState(state) {
  assert.equal(state.outputMenu.visible, false, "Escape should close only the output context menu");
  assert.equal(state.pluginTitle, "插件运行态预览", "Escape from the output menu should not leave plugin mode");
  assert.equal(state.outputRowCount, 2, "Escape should not mutate plugin output rows");
  assert.equal(state.outputRows[1]?.hint, "Enter 复制", "Escape should preserve the current output selection");
}

function assertPluginOutputContextMenuCopyState(state) {
  assert.equal(state.outputMenu.visible, false, "copying from the output menu should close the menu");
  assert.equal(state.pluginTitle, "插件运行态预览", "copying from the output menu should keep plugin mode active");
  assert.equal(
    state.outputRowCount,
    1,
    `expected copied feedback state, got ${JSON.stringify({
      outputRows: state.outputRows,
      outputMenu: state.outputMenu,
      copiedText: state.copiedText,
    })}`,
  );
  assert.deepEqual(state.outputRows, [
    { title: "已复制", description: "1710000000000", hint: "Enter 复制" },
  ]);
  assert.equal(state.copiedText, "1710000000000");
}

async function movePluginOutputSelectionDown(page) {
  const focusResponse = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const input = document.querySelector(".sub-input");
      input?.focus();
      return document.activeElement === input;
    })()`,
  });
  if (focusResponse.exceptionDetails) {
    assert.fail(focusResponse.exceptionDetails.text || "Failed to focus plugin SubInput");
  }
  assert.equal(focusResponse.result.value, true, "plugin SubInput should be focusable before keyboard selection");

  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  });

  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await readPluginHostSmokeState(page);
    if (state.outputRows?.[1]?.hint === "Enter 复制") {
      return state;
    }
    await delay(100);
  } while (Date.now() < deadline);
  return state;
}

async function openPluginOutputContextMenu(page, rowIndex) {
  const point = await outputRowPoint(page, rowIndex);
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
  return waitForPluginOutputMenu(page, true);
}

async function closePluginOutputContextMenuWithEscape(page) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  return waitForPluginOutputMenu(page, false);
}

async function copyPluginOutputFromContextMenu(page, rowIndex) {
  await openPluginOutputContextMenu(page, rowIndex);
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const button = document.querySelector(".plugin-output-menu button");
      if (!button) return false;
      button.click();
      return true;
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to click plugin output menu item");
  }
  assert.equal(response.result.value, true, "plugin output menu item should be clickable");
  return waitForPluginCopiedFeedback(page);
}

async function outputRowPoint(page, rowIndex) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const row = document.querySelectorAll(".result-item")[${rowIndex}];
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width - 8, Math.max(8, rect.width / 2)), y: rect.top + rect.height / 2 };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to locate plugin output row");
  }
  assert.ok(response.result.value, `plugin output row ${rowIndex} should exist`);
  return response.result.value;
}

async function waitForPluginOutputMenu(page, visible) {
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await readPluginHostSmokeState(page);
    if (state.outputMenu.visible === visible) {
      return state;
    }
    await delay(100);
  } while (Date.now() < deadline);
  return state;
}

async function waitForPluginCopiedFeedback(page) {
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await readPluginHostSmokeState(page);
    if (state.outputRows?.[0]?.title === "已复制") {
      return state;
    }
    await delay(100);
  } while (Date.now() < deadline);
  return state;
}

async function waitForPluginHostSmoke(page) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readPluginHostSmokeState(page);
    if (
      state.title === "ATools 3.0"
      && state.pluginTitle === "插件运行态预览"
      && state.runtimeChipCount === 4
      && state.outputRowCount === 2
      && state.subInput.value === "time"
      && state.viteOverlayCount === 0
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readPluginHostSmokeState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rectOf = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const intersects = (a, b) => a && b && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
        && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const layoutRects = [
        rectOf(".plugin-header"),
        rectOf(".plugin-runtime-strip"),
        rectOf(".sub-input-row"),
        rectOf(".plugin-body"),
      ].filter(Boolean);
      const overlaps = [];
      for (let i = 0; i < layoutRects.length; i += 1) {
        for (let j = i + 1; j < layoutRects.length; j += 1) {
          if (intersects(layoutRects[i], layoutRects[j])) {
            overlaps.push(layoutRects[i].selector + " overlaps " + layoutRects[j].selector);
          }
        }
      }
      const runtimeChips = Array.from(document.querySelectorAll(".runtime-chip")).map((chip) => ({
        label: chip.querySelector("span")?.textContent?.trim() || "",
        value: chip.querySelector("strong")?.textContent?.trim() || "",
        detail: chip.querySelector("small")?.textContent?.replace(/\\s+/g, " ").trim() || "",
      }));
      const outputRows = Array.from(document.querySelectorAll(".result-item")).map((row) => ({
        title: row.querySelector(".result-title")?.textContent?.trim() || "",
        description: row.querySelector(".result-description")?.textContent?.trim() || "",
        hint: row.querySelector(".result-hint")?.textContent?.trim() || "",
      }));
      const outputMenu = document.querySelector(".plugin-output-menu");
      const bodyRect = rectOf(".plugin-body");
      const outputRect = rectOf(".plugin-output-layer");
      const subInput = document.querySelector(".sub-input");
      const root = document.documentElement;
      const body = document.body;
      const overlaySelectors = [
        "vite-error-overlay",
        ".vite-error-overlay",
        ".svelte-error-overlay",
        "[data-sveltekit-error]",
      ];
      return {
        title: document.title,
        pluginTitle: document.querySelector(".plugin-title")?.textContent?.trim() || "",
        featureCode: document.querySelector(".feature-code")?.textContent?.trim() || "",
        pluginSource: document.querySelector(".plugin-source")?.textContent?.trim() || "",
        runtimeChipCount: runtimeChips.length,
        runtimeChips,
        subInput: {
          placeholder: subInput?.getAttribute("placeholder") || "",
          value: subInput?.value || "",
        },
        outputRowCount: outputRows.length,
        outputRows,
        outputMenu: {
          visible: Boolean(outputMenu),
          label: outputMenu?.querySelector("button")?.textContent?.trim() || "",
        },
        copiedText: window.__atoolsPluginOutputCopiedText || "",
        hasIframeBody: Boolean(document.querySelector(".plugin-body iframe")),
        outputLayerCount: document.querySelectorAll(".plugin-output-layer").length,
        outputInsideBody: Boolean(bodyRect && outputRect
          && outputRect.left >= bodyRect.left - 1
          && outputRect.right <= bodyRect.right + 1
          && outputRect.top >= bodyRect.top - 1
          && outputRect.bottom <= bodyRect.bottom + 1),
        overlaps,
        viteOverlayCount: overlaySelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        documentOverflows: root.scrollWidth > root.clientWidth + 1,
        bodyOverflows: body.scrollWidth > body.clientWidth + 1,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate pluginHostSmoke state");
  }
  return response.result.value;
}

await main();
