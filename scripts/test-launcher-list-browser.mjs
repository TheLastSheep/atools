import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url).pathname;
const origin = "http://127.0.0.1:1451";
const output = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
let server;
let chrome;
let page;
const consoleIssues = [];

async function evaluate(expression) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function snapshot() {
  return evaluate(`(() => {
    const list = document.querySelector('[role="listbox"]');
    const bounds = list.getBoundingClientRect();
    const selected = list.querySelector('[role="option"][aria-selected="true"]');
    const selectedBounds = selected?.getBoundingClientRect();
    return {
      rowCount: list.querySelectorAll('[role="option"]').length,
      maximumRows: window.__viewportMaximumRows,
      scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
      virtualHeight: list.querySelector('.result-viewport').getBoundingClientRect().height,
      selectedIndex: selected ? Number(selected.dataset.resultIndex) : null,
      selectedLabel: selected?.querySelector('.result-title')?.textContent,
      selectedPosition: Number(selected?.getAttribute('aria-posinset')),
      selectedSetSize: Number(selected?.getAttribute('aria-setsize')),
      selectedVisible: !!selectedBounds && selectedBounds.top >= bounds.top - 1 && selectedBounds.bottom <= bounds.bottom + 1,
      rowIndexes: [...list.querySelectorAll('[role="option"]')].map(row => Number(row.dataset.resultIndex)),
      groups: [...list.querySelectorAll('[role="group"]')].map(group => {
        const rect = group.getBoundingClientRect();
        return {
          label: group.getAttribute('aria-label'), top: rect.top, height: rect.height,
          headerHeight: group.querySelector('.group-header').getBoundingClientRect().height,
          rows: [...group.querySelectorAll('[role="option"]')].map(row => {
            const box = row.getBoundingClientRect();
            return { index: Number(row.dataset.resultIndex), position: Number(row.getAttribute('aria-posinset')), top: box.top, height: box.height };
          }),
        };
      }),
    };
  })()`);
}

async function settle(expression) {
  return evaluate(`(async () => {
    ${expression}
    window.__viewportRuntime.flushSync();
    await window.__viewportRuntime.tick();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

try {
  await mkdir(output, { recursive: true });
  server = await launchViteServer({ cwd: root, port: 1451, probeUrl: origin });
  const mainSource = await (await fetch(`${origin}/src/main.ts`)).text();
  const runtimePath = mainSource.match(/import\s*\{\s*mount\s*\}\s*from\s*["']([^"']+)["']/)?.[1];
  assert.ok(runtimePath, "Vite should expose the same Svelte runtime used by the real app");
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  page.on("Runtime.consoleAPICalled", (params) => {
    if (["warning", "error", "assert"].includes(params.type)) consoleIssues.push(`${params.type}: ${formatConsoleArgs(params.args)}`);
  });
  page.on("Runtime.exceptionThrown", (params) => consoleIssues.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`));
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const browserVersion = await page.send("Browser.getVersion");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 660, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: origin });
  await loaded;
  await evaluate(`(async () => {
    const app = await import('/src/main.ts');
    const runtime = await import(${JSON.stringify(runtimePath)});
    await runtime.unmount(app.default);
    window.__viewportRuntime = runtime;
  })()`);
  // Discard the ordinary app's expected browser-only diagnostics before mounting
  // the fixture; all warnings and errors during fixture mount remain observable.
  consoleIssues.length = 0;
  const timing = await evaluate(`(async () => {
    const runtime = window.__viewportRuntime;
    const Harness = (await import('/tests/components/LauncherViewportBrowserHarness.svelte')).default;
    document.documentElement.dataset.atoolsTheme = 'light';
    const target = document.getElementById('app');
    target.style.cssText = 'width:800px;height:auto;min-height:0;margin:40px auto;border:1px solid var(--border-strong);border-radius:12px;overflow:hidden;background:var(--bg-primary)';
    target.innerHTML = '<header style="padding:20px 24px;border-bottom:1px solid var(--border)"><h1 style="font-size:20px">1200 条命令 · 窗口化结果</h1><p style="color:var(--text-secondary);margin-top:4px">真实 ResultsList 组件 / 浏览器预览验证</p></header><div id="viewport-fixture"></div>';
    document.body.style.cssText = 'background:#e8ecf1;min-height:660px;overflow:auto';
    window.__viewportResults = Array.from({ length:1200 }, (_, index) => ({
      code:'command-'+index, plugin_id:'plugin-'+(index%12), plugin_name:'插件 '+(index%12),
      label:'测试命令 '+index, icon:null, explain:'本地离线命令 · 搜索与键盘导航样本 '+index,
      score:1200-index, match_type:'contains',
    }));
    window.__viewportMaximumRows = 0;
    new MutationObserver(() => {
      window.__viewportMaximumRows = Math.max(window.__viewportMaximumRows, target.querySelectorAll('[role="option"]').length);
    }).observe(target, { childList:true, subtree:true });
    const started = performance.now();
    window.__viewportFixture = runtime.mount(Harness, {
      target:document.getElementById('viewport-fixture'),
      props:{ initialResults:window.__viewportResults, initialQuery:'测试',
        onready:controller => window.__viewportController=controller,
        onactivate:index => window.__viewportActivated=index },
    });
    runtime.flushSync();
    await runtime.tick();
    const mountAndFlushMs = performance.now()-started;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { mountAndFlushMs, mountThroughTwoFramesMs:performance.now()-started };
  })()`);
  const initial = await snapshot();
  await settle("const list=document.querySelector('[role=\"listbox\"]'); list.scrollTop=20000; list.dispatchEvent(new Event('scroll'));");
  const scrolled = await snapshot();
  await settle("window.__viewportController.select(1199);");
  const lastSelected = await snapshot();
  await evaluate("document.querySelector('[role=\"option\"][aria-selected=\"true\"]').click()");
  const activatedIndex = await evaluate("window.__viewportActivated");
  await settle("const list=document.querySelector('[role=\"listbox\"]'); list.scrollTop=20000; list.dispatchEvent(new Event('scroll'));");
  const offscreenSelected = await snapshot();
  await settle("window.__viewportController.replace(window.__viewportResults.map(row=>({...row,label:row.label.replace('测试','新查询')})), '新查询');");
  const queryReset = await snapshot();
  await settle("const list=document.querySelector('[role=\"listbox\"]'); list.scrollTop=5370; list.dispatchEvent(new Event('scroll')); window.__viewportController.select(1);");
  const groupBoundary = await snapshot();
  const capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL("viewport.png", output), Buffer.from(capture.data, "base64"));
  const report = {
    status: "observed",
    environment: "Chromium headless + Vite browser preview; real ResultsList via reactive test harness; not native Tauri frame timing",
    browserVersion,
    dataset: { results: 1200, groups: 12 }, timing,
    initial, scrolled, lastSelected, offscreenSelected, queryReset, groupBoundary, activatedIndex,
    screenshot: "viewport.png", consoleIssues,
  };
  await writeFile(new URL("viewport.json", output), `${JSON.stringify(report, null, 2)}\n`);

  for (const state of [initial, scrolled, lastSelected, offscreenSelected, queryReset, groupBoundary]) {
    assert.ok(state.rowCount <= 32 && state.maximumRows <= 32, "Every mounted and observed DOM window must remain bounded");
    assert.equal(state.selectedSetSize, 1200);
    for (const group of state.groups) {
      assert.equal(group.headerHeight, 24);
      assert.ok(group.rows.every(row => row.height === 54), "Rows retain exact 54px geometry");
      group.rows.slice(1).forEach((row, index) => {
        const previous = group.rows[index];
        if (row.position === previous.position + 1) assert.equal(row.top - previous.top, 54);
      });
    }
  }
  assert.equal(initial.virtualHeight, 65132);
  assert.ok(scrolled.rowIndexes.some(index => !initial.rowIndexes.includes(index)));
  assert.equal(lastSelected.selectedIndex, 1199);
  assert.equal(lastSelected.selectedPosition, 1200);
  assert.equal(lastSelected.selectedVisible, true);
  assert.equal(activatedIndex, 1199);
  assert.equal(offscreenSelected.selectedIndex, 1199);
  assert.equal(offscreenSelected.selectedVisible, false);
  assert.equal(queryReset.scrollTop, 0);
  assert.equal(queryReset.selectedIndex, 0);
  assert.equal(queryReset.selectedVisible, true);
  assert.match(queryReset.selectedLabel, /^新查询/);
  const firstGroup = groupBoundary.groups.find(group => group.label === "插件 0");
  const secondGroup = groupBoundary.groups.find(group => group.label === "插件 1");
  assert.ok(firstGroup && secondGroup, "The group boundary viewport should render both adjacent groups");
  assert.equal(secondGroup.top - firstGroup.top - firstGroup.height, 4);
  assert.deepEqual(consoleIssues, []);
  report.status = "passed";
  await writeFile(new URL("viewport.json", output), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify({ ok: true, timing, initialRows: initial.rowCount, maximumRows: groupBoundary.maximumRows, output: output.pathname }));
} finally {
  await page?.close?.();
  await Promise.allSettled([chrome?.close?.(), server?.close?.()]);
}
