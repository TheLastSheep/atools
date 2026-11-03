// @vitest-environment node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runPluginActionsMenuScenario } from "./pluginActionsBrowserMenuScenario";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { CdpClient, launchViteServer } from "../../scripts/chrome-cdp-smoke-utils.mjs";
import { launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";

const acceptanceEnabled = process.env.ATOOLS_PLUGIN_ACTIONS_BROWSER_ACCEPTANCE === "1";
const route = process.env.ATOOLS_PLUGIN_ACTIONS_BROWSER_ROUTE ?? "baseline";
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const port = 1537;
const origin = `http://127.0.0.1:${port}`;
const pageUrl = `${origin}/tests/components/plugin-actions-browser.html?route=${encodeURIComponent(route)}`;
const outputRoot = resolve(process.cwd(), "output/playwright/plugin-actions-browser");
const missing = [
  ...(acceptanceEnabled ? [] : ["ATOOLS_PLUGIN_ACTIONS_BROWSER_ACCEPTANCE=1 not set"]),
  ...(["baseline", "menu"].includes(route) ? [] : ["ATOOLS_PLUGIN_ACTIONS_BROWSER_ROUTE must be baseline or menu"]),
  ...(existsSync(productNode) ? [] : [`bundled product Node missing: ${productNode}`]),
].join("; ");
const optIn = missing.length === 0;

type FixtureEnvironment = Awaited<ReturnType<typeof createFixtureEnvironment>>;
type BrowserSession = Awaited<ReturnType<typeof launchPasteBrowserSession>>;
type NetworkGate = ReturnType<typeof installLocalNetworkGate>;
type TargetEvent = { targetId: string; type: string; url: string; openerId?: string; eventKind?: string };

it.skipIf(!optIn)(`captures PluginNavigationBar ${route} route across narrow widths and themes (${missing || "opted in"})`, async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId,
    status: "setup",
    route,
    scope: route === "baseline"
      ? "Production PluginNavigationBar baseline in private headless Chrome with a strict owned Vite port; menu acceptance is a separate route."
      : "Production PluginNavigationBar menu acceptance in private headless Chrome with a strict owned Vite port and same-origin iframe fixture.",
    menuAcceptance: route === "baseline" ? { status: "separate-menu-route", passed: false } : { status: "pending", passed: false },
    browserNetwork: { allowedOrigin: origin, blockedExternalOrigins: [], seenOrigins: [] },
    screenshots: [],
    geometry: [],
    callbacks: [],
    cleanup: { errors: [], chromePid: null, chromeState: "not_started", viteCloseConfirmed: false, fixtureEnvironmentRemoved: false },
  };
  let isolation: FixtureEnvironment | undefined;
  let browser: BrowserSession | undefined;
  let vite: { close(): Promise<void> } | undefined;
  let page: CdpClient | undefined;
  let networkGate: NetworkGate | undefined;
  let chromeConfirmed = true;
  let viteConfirmed = true;
  let failure: unknown;

  try {
    await mkdir(outputRoot, { recursive: true });
    expect(resolve(process.execPath)).toBe(productNode, "run Vitest directly with the bundled Node 22.23.3 binary");
    isolation = await createFixtureEnvironment();
    await assertPortUnoccupied(port);
    vite = await launchViteServer({
      host: "127.0.0.1",
      port,
      probeUrl: pageUrl,
      timeoutMs: 20_000,
    });
    report.viteServer = {
      origin,
      strictPort: true,
      ownedLaunchHelper: "launchViteServer",
      workerPidExposure: "launchViteServer owns cleanup but does not expose its worker PID",
    };
    const localResponse = await fetch(pageUrl, { redirect: "manual" });
    assert.equal(localResponse.status, 200, "owned Vite listener serves this fixture route");
    assert.equal(new URL(localResponse.url).origin, origin, "fixture page must remain on the owned local origin");
    await localResponse.body?.cancel();

    const targetEvents: TargetEvent[] = [];
    const destroyedTargets: string[] = [];
    browser = await launchPasteBrowserSession({
      tempRoot: isolation.env.XDG_DATA_HOME,
      env: isolation.env,
      targetEvents,
      destroyedTargets,
      fixtureOrigin: origin,
    });
    report.browser = browser.lifecycle;
    report.cleanup.chromePid = browser.lifecycle.browserPid ?? null;
    page = browser.harness;
    await page.send("Page.enable", {}, { timeoutMs: 5000 });
    await page.send("Runtime.enable", {}, { timeoutMs: 5000 });
    await page.send("Network.enable", {}, { timeoutMs: 5000 });
    networkGate = installLocalNetworkGate(page, origin, report.browserNetwork);
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, { timeoutMs: 5000 });
    const javascriptErrors: string[] = [];
    page.on("Runtime.exceptionThrown", event => javascriptErrors.push(String(event.exceptionDetails?.text ?? "browser exception")));
    page.on("Runtime.consoleAPICalled", event => {
      if (event.type === "error") javascriptErrors.push(String(event.args?.map((item: any) => item.value ?? item.description ?? "").join(" ")));
    });
    await page.send("Page.navigate", { url: pageUrl }, { timeoutMs: 5000 });
    await waitForFixture(page, 15_000);
    await networkGate.settle();
    report.browser = { ...browser.lifecycle, privateProfile: true, baselinePageTargetIds: browser.baselinePageTargetIds };

    if (route === "baseline") {
      for (const width of [320, 480, 760]) {
        for (const theme of ["light", "dark"] as const) {
          await page.send("Emulation.setDeviceMetricsOverride", {
            width, height: 900, deviceScaleFactor: 1, mobile: false,
          }, { timeoutMs: 5000 });
          await evaluate(page, `document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
          await delay(40);
          const geometry = await measureGeometry(page, width, theme);
          report.geometry.push(geometry);
          const screenshot = await page.send("Page.captureScreenshot", {
            format: "png", captureBeyondViewport: false,
          }, { timeoutMs: 5000 });
          const screenshotPath = join(outputRoot, `${runId}-${width}-${theme}.png`);
          await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"), { flag: "wx", mode: 0o600 });
          report.screenshots.push({ width, theme, path: screenshotPath, bytes: Buffer.byteLength(screenshot.data, "base64") });
        }
      }

      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 760, height: 900, deviceScaleFactor: 1, mobile: false,
      }, { timeoutMs: 5000 });
      await evaluate(page, `document.documentElement.dataset.atoolsTheme="light"`);
      const initial = await readFixtureState(page);
      expect(await evaluate<string>(page, `document.querySelector('[aria-label="更多插件操作"]')?.getAttribute('aria-expanded')??''`)).toBe("false");
      const warning = await evaluate(page, `(()=>{const button=document.querySelector('.runtime-info-action');return {label:button?.getAttribute('aria-label'),expanded:button?.getAttribute('aria-expanded'),warning:button?.classList.contains('has-warning')}})()`);
      expect(warning).toEqual({ label: "运行信息，有警告", expanded: "false", warning: true });

      await clickSelector(page, ".runtime-info-action");
      await waitForFixtureCondition(page, `document.querySelector('.runtime-info-action')?.getAttribute('aria-expanded')==='true'`);
      await clickSelector(page, "#fixture-body-action");
      await clickSelector(page, ".sub-input");
      await page.send("Input.insertText", { text: "Harris browser baseline" }, { timeoutMs: 5000 });
      await waitForFixtureCondition(page, `document.querySelector('.sub-input')?.value==='Harris browser baseline'`);
      await clickSelector(page, ".sub-input-clear");
      await waitForFixtureCondition(page, `document.querySelector('.sub-input')?.value===''`);
      await clickSelector(page, ".back-btn");
      const finalState = await readFixtureState(page);
      report.callbacks = finalState.callbacks;
      report.callbackSummary = summarizeCallbacks(finalState.callbacks);
      expect(report.callbackSummary).toEqual({
        detach: 0, settings: 0, runtimeInfo: 1, body: 1, returns: 1,
        inputs: ["Harris browser baseline", ""],
      });
      expect(initial.callbacks).toEqual([]);
      report.status = "baseline-captured-menu-acceptance-pending";
    } else {
      report.menuAcceptance = await runPluginActionsMenuScenario(page, outputRoot, runId, report);
      report.status = "menu-acceptance-passed";
    }
    report.javascriptErrors = javascriptErrors;
    expect(javascriptErrors).toEqual([]);
    await networkGate.settle();
    report.browserNetwork.seenOrigins = networkGate.snapshot().seenOrigins;
    expect(report.browserNetwork.blockedExternalOrigins).toEqual([]);
    expect(report.browserNetwork.seenOrigins).toContain(origin);
    expect(report.browserNetwork.seenOrigins.every((value: string) => {
      const seen = new URL(value);
      return seen.hostname === "127.0.0.1" && seen.port === String(port)
        && ["http:", "ws:"].includes(seen.protocol);
    })).toBe(true);
  } catch (error) {
    failure = error;
    report.status = route === "menu" ? "menu-acceptance-failed" : "baseline-capture-failed";
    if (route === "menu") report.menuAcceptance = { status: "failed", passed: false, route: "menu" };
    report.failure = describeError(error);
    const chromeLifecycle = (error as any)?.atoolsChromeLifecycle;
    if (chromeLifecycle) {
      report.failedChromeLifecycle = chromeLifecycle;
      chromeConfirmed = ["exited", "not_spawned"].includes(String(chromeLifecycle.processState))
        && String(chromeLifecycle.profileState) === "removed";
    }
    const viteLifecycle = (error as any)?.atoolsLifecycle?.vite ?? (error as any)?.ownedViteLifecycle;
    if (viteLifecycle) {
      report.failedViteLifecycle = viteLifecycle;
      viteConfirmed = ["exited", "not_spawned"].includes(String(viteLifecycle.processState))
        && ["removed", "not_created"].includes(String(viteLifecycle.cacheState));
    }
  } finally {
    if (networkGate) {
      try {
        await networkGate.settle();
        report.browserNetwork.seenOrigins = networkGate.snapshot().seenOrigins;
      }
      catch (error) { report.cleanup.errors.push(describeError(error)); }
    }
    if (browser) {
      try {
        const lifecycle = await browser.close();
        report.cleanup.chromeState = lifecycle.processState;
        report.cleanup.chromeProfileState = lifecycle.profileState;
        chromeConfirmed = lifecycle.processState === "exited" && lifecycle.profileState === "removed";
      } catch (error) {
        report.cleanup.errors.push(describeError(error));
        report.cleanup.chromeState = browser.lifecycle.processState;
        report.cleanup.chromeProfileState = browser.lifecycle.profileState;
        chromeConfirmed = browser.lifecycle.processState === "exited" && browser.lifecycle.profileState === "removed";
      }
    }
    if (vite) {
      try {
        await vite.close();
        viteConfirmed = true;
        report.cleanup.viteCloseConfirmed = true;
      } catch (error) {
        viteConfirmed = false;
        report.cleanup.errors.push(describeError(error));
      }
    }
    if (isolation) {
      if (chromeConfirmed && viteConfirmed) {
        try {
          await isolation.cleanup();
          report.cleanup.fixtureEnvironmentRemoved = true;
        } catch (error) {
          report.cleanup.errors.push(describeError(error));
        }
      } else {
        report.cleanup.fixtureEnvironmentPreserved = isolation.root;
      }
    }
    report.cleanup.chromeConfirmed = chromeConfirmed;
    report.cleanup.viteConfirmed = viteConfirmed;
    report.cleanup.complete = chromeConfirmed && viteConfirmed
      && (isolation === undefined || report.cleanup.fixtureEnvironmentRemoved === true)
      && report.cleanup.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    report.reportPath = join(outputRoot, `${runId}-report.json`);
    try {
      await writeFile(report.reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) throw new Error(`Plugin actions browser ${route} route failed; report ${report.reportPath}`, { cause: failure });
  expect(report.status).toBe(route === "menu" ? "menu-acceptance-passed" : "baseline-captured-menu-acceptance-pending");
  expect(report.cleanup.complete).toBe(true);
}, 90_000);

async function assertPortUnoccupied(requestedPort: number) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: "127.0.0.1", port: requestedPort });
    const timer = setTimeout(() => finish(new Error(`Could not prove dedicated Vite port ${requestedPort} is unoccupied`)), 750);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    socket.once("connect", () => finish(new Error(`Refusing to reuse an existing listener on 127.0.0.1:${requestedPort}`)));
    socket.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") finish();
      else finish(error);
    });
  });
}

function installLocalNetworkGate(page: CdpClient, allowedOrigin: string, report: Record<string, any>) {
  const pending = new Set<Promise<void>>();
  const allowed = new URL(allowedOrigin);
  const seenOrigins = new Set<string>();
  page.on("Network.requestWillBeSent", event => {
    try {
      const url = new URL(event.request.url);
      if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) seenOrigins.add(url.origin);
    }
    catch { seenOrigins.add("<invalid-url>"); }
  });
  page.on("Fetch.requestPaused", event => {
    let url: URL | undefined;
    try { url = new URL(event.request.url); } catch {}
    const local = url && url.hostname === allowed.hostname && url.port === allowed.port
      && ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
    if (!local && url && ["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      report.blockedExternalOrigins.push(url.origin);
    }
    const command = local || !url || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)
      ? page.send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 5000 })
      : page.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 5000 });
    let task: Promise<void>;
    task = command.then(() => {}).catch(error => {
      report.gateErrors ??= [];
      report.gateErrors.push(describeError(error));
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  return {
    async settle() { await Promise.all([...pending]); },
    snapshot() { return { seenOrigins: [...seenOrigins].sort() }; },
  };
}

async function evaluate<T>(page: CdpClient, expression: string): Promise<T> {
  const response = await page.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, { timeoutMs: 5000 });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  return response.result?.value as T;
}

async function waitForFixture(page: CdpClient, timeoutMs: number) {
  await waitUntil(async () => await evaluate<boolean>(page,
    `document.readyState==='complete'&&typeof window.pluginActionsBrowserFixture?.getState==='function'&&Boolean(document.querySelector('.plugin-navigation'))`), timeoutMs,
  "plugin actions fixture did not mount");
}

async function waitForFixtureCondition(page: CdpClient, expression: string) {
  await waitUntil(async () => await evaluate<boolean>(page, expression), 5000, `fixture condition timed out: ${expression}`);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await delay(25);
  }
  throw new Error(message);
}

async function measureGeometry(page: CdpClient, width: number, theme: "light" | "dark") {
  const value = await evaluate<Record<string, any>>(page, `(()=>{
    const rect=(element)=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left}};
    const navigation=document.querySelector('.plugin-navigation');
    const input=document.querySelector('.sub-input');
    const body=document.querySelector('[data-plugin-body]');
    return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth,navigation:rect(navigation),input:rect(input),body:rect(body),
      bodyBelowNavigation:Boolean(navigation&&body&&body.getBoundingClientRect().top>=navigation.getBoundingClientRect().bottom-1),
      settingsDisabled:document.querySelector('.chrome-action[title="设置未接入"]')?.disabled??null,
      title:{clientWidth:document.querySelector('.plugin-title')?.clientWidth??0,scrollWidth:document.querySelector('.plugin-title')?.scrollWidth??0}};
  })()`);
  return { width, theme, navigationHeight: value.navigation?.height ?? null,
    subInputWidth: value.input?.width ?? null, horizontalOverflow: value.horizontalOverflow,
    documentWidth: value.documentWidth, bodyTop: value.body?.top ?? null, bodyBelowNavigation: value.bodyBelowNavigation,
    title: value.title };
}

async function clickSelector(page: CdpClient, selector: string) {
  const bounds = await evaluate<{ x: number; y: number; width: number; height: number } | null>(page, `(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;
    const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
  })()`);
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `button target is visible: ${selector}`);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { timeoutMs: 5000 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
}

async function readFixtureState(page: CdpClient) {
  return evaluate<Record<string, any>>(page, "window.pluginActionsBrowserFixture.getState()");
}

function summarizeCallbacks(callbacks: Array<Record<string, any>>) {
  return {
    detach: callbacks.filter(item => item.type === "action" && item.actionId === "detach").length,
    settings: callbacks.filter(item => item.type === "action" && item.actionId === "settings").length,
    runtimeInfo: callbacks.filter(item => item.type === "runtime-info").length,
    body: callbacks.filter(item => item.type === "body").length,
    returns: callbacks.filter(item => item.type === "return").length,
    inputs: callbacks.filter(item => item.type === "input").map(item => item.value),
  };
}

function describeError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(milliseconds: number) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}
