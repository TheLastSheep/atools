import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { delay, formatConsoleArgs } from "../chrome-cdp-smoke-utils.mjs";

/** CDP-only interaction helpers for the original settings DOM and its owned fixture transport. */
export function createSettingsAliasBrowserDriver({
  pageProvider,
  outputDir,
  originProvider,
  allowedDistPaths,
  report,
  documentProvider,
  pendingRequests,
}) {
  async function evaluate(expression, timeoutMs = 10000) {
    const result = await pageProvider().send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    }, { timeoutMs });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser expression failed");
    }
    return result.result.value;
  }

  async function waitFor(expression, timeoutMs = 16000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean((${expression}))`, 3000)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for original settings DOM: ${expression}`);
  }

  async function visibleDomSnapshot(label) {
    const snapshot = await evaluate(`(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const text = element => (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
      const selector = "button,a,input,[role],li,.card.command-card,.alias-table-row,.tag-dropdown,.dropdown-menu,.dropdown-item,.dialog-overlay,.dialog-container,.dialog-message,.dialog-footer";
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || "").slice(0, 16000),
        elements: Array.from(document.querySelectorAll(selector)).slice(0, 500).map(element => ({
          tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), type: element.getAttribute("type"),
          className: typeof element.className === "string" ? element.className : "",
          title: element.getAttribute("title"), placeholder: element.getAttribute("placeholder"),
          text: text(element).slice(0, 240), value: "value" in element ? String(element.value).slice(0, 240) : null,
          visible: visible(element)
        }))
      };
    })()`);
    report.domDiagnostics.push({ label, ...snapshot });
    return snapshot;
  }

  async function elementPoint(expression, label) {
    const hoverPoint = await evaluate(`(() => {
      const element = ${expression};
      if (!element?.isConnected) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    assert.ok(hoverPoint, `Expected rendered DOM target: ${label}`);
    await pageProvider().send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hoverPoint });
    await waitFor(`(() => {
      const element = ${expression};
      if (!element?.isConnected || element.disabled) return false;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        if (parent.getAnimations().some(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)) return false;
      }
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit));
    })()`, 5000);
    const point = await evaluate(`(() => {
      const element = ${expression};
      if (!element || !element.isConnected) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (element.innerText || element.textContent || "").trim() };
    })()`);
    assert.ok(point, `Expected visible DOM target: ${label}`);
    return point;
  }

  async function clickElement(expression, label) {
    const point = await elementPoint(expression, label);
    const page = pageProvider();
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }

  async function clickText(text, selector, label, scope = "document") {
    const matches = await evaluate(`(() => {
      const scope = ${scope};
      if (!scope) return [];
      const expected = ${JSON.stringify(text)};
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      return Array.from(scope.querySelectorAll(${JSON.stringify(selector)}))
        .map((element, index) => ({ index, elementText: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim(), visible: visible(element) }))
        .filter(item => item.visible && item.elementText === expected);
    })()`);
    assert.equal(matches.length, 1, `${label} must match exactly one visible DOM control, found ${matches.length}`);
    await clickElement(`Array.from((${scope}).querySelectorAll(${JSON.stringify(selector)}))[${matches[0].index}]`, label);
  }

  async function fillInput(expression, value, replace, label) {
    await clickElement(expression, label);
    if (replace) await evaluate(`(${expression}).select()`);
    await pageProvider().send("Input.insertText", { text: value });
    await waitFor(`(${expression})?.value === ${JSON.stringify(value)}`, 5000);
  }

  async function navigate(url, documentKey) {
    documentProvider.set(documentKey);
    const page = pageProvider();
    const currentUrl = await evaluate("location.href");
    const current = new URL(currentUrl);
    const next = new URL(url);
    const sameDocument = ["origin", "pathname", "search"].every(key => current[key] === next[key]);
    const loaded = page.waitForEvent("Page.loadEventFired", 20000);
    if (sameDocument) {
      if (currentUrl !== url) await page.send("Page.navigate", { url });
      await page.send("Page.reload", { ignoreCache: true });
    } else await page.send("Page.navigate", { url });
    await loaded;
    await waitFor(`document.querySelector("#app") && document.querySelector("#app").innerText.trim().length > 0`);
  }

  async function captureScreenshot(name) {
    const result = await pageProvider().send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
    }, { timeoutMs: 12000 });
    const bytes = Buffer.from(result.data, "base64");
    const file = `${name}.png`;
    await writeFile(join(outputDir, file), bytes, { flag: "wx" });
    report.screenshots.push({
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      document: documentProvider.get(),
    });
  }

  async function collectFixtureDocument(stageName) {
    const snapshot = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.() ?? null");
    assert.ok(snapshot, "The synthetic native transport fixture should be installed before Vue startup");
    report.documents.push({ stage: stageName, ...snapshot });
    return snapshot;
  }

  function onPageDiagnostics() {
    const page = pageProvider();
    page.on("Runtime.exceptionThrown", event => {
      const details = event.exceptionDetails || {};
      report.console.runtimeExceptions.push({
        document: documentProvider.get(),
        message: (details.exception?.description || details.text || "runtime exception").slice(0, 1200),
      });
    });
    page.on("Runtime.consoleAPICalled", event => {
      const text = formatConsoleArgs(event.args).slice(0, 1600);
      if (event.type === "warning") {
        report.console.warnings.push({ document: documentProvider.get(), text });
        return;
      }
      if (!["error", "assert"].includes(event.type)) return;
      const record = { document: documentProvider.get(), type: event.type, text };
      report.console.errors.push(record);
      const unsupportedPrefixes = ["加载全局快捷键失败:", "加载应用快捷键失败:"];
      if (unsupportedPrefixes.some(prefix => text.startsWith(prefix)) && text.includes("此设置暂不支持修改。")) {
        report.console.expectedUnsupported.push(record);
        return;
      }
      if (text.startsWith("保存指令别名失败:") && text.includes("设置已变化，请关闭并重新打开。")) {
        report.console.expectedAliasConflict.push(record);
        return;
      }
      report.console.unexpectedErrors.push(record);
    });
    page.on("Fetch.requestPaused", event => {
      const work = (async () => {
        const requestUrl = new URL(event.request.url);
        const allowed = requestUrl.origin === originProvider()
          && requestUrl.protocol === "http:"
          && event.request.method === "GET"
          && allowedDistPaths.has(requestUrl.pathname);
        const record = { origin: requestUrl.origin, path: requestUrl.pathname, method: event.request.method, allowed };
        report.network.requests.push(record);
        if (allowed) {
          await pageProvider().send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 7000 });
        } else {
          report.network.blocked.push(record);
          if (requestUrl.origin !== originProvider()) report.network.externalAttempts.push(record);
          await pageProvider().send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 7000 });
        }
      })().catch(error => report.cleanup.errors.push(`Fetch interception: ${error.message || error}`))
        .finally(() => pendingRequests.delete(work));
      pendingRequests.add(work);
    });
  }

  function collectConsoleBlockers() {
    const expectedAliasConflicts = new Set(report.console.expectedAliasConflict);
    const records = [
      ...report.console.runtimeExceptions.map(record => ({ ...record, source: "runtime-exception" })),
      ...report.console.errors
        .filter(record => !expectedAliasConflicts.has(record))
        .map(record => ({ ...record, source: "console-error", message: record.text })),
    ];
    const unsupported = [];
    const other = [];
    for (const record of records) {
      const message = record.message || record.text || "";
      const destination = /HostUnsupportedError|此设置暂不支持修改/.test(message) ? unsupported : other;
      destination.push({
        source: record.source,
        document: record.document,
        type: record.type || null,
        message,
      });
    }
    return { unsupported, other };
  }

  return Object.freeze({
    evaluate, waitFor, visibleDomSnapshot, clickElement, clickText, fillInput, navigate,
    captureScreenshot, collectFixtureDocument, onPageDiagnostics, collectConsoleBlockers,
  });
}
