import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { CdpClient, createPageWebSocketUrl, findChromePath } from "../../../scripts/chrome-cdp-smoke-utils.mjs";

type TargetInfo = { targetId: string; type: string; url: string; openerId?: string; eventKind?: string };
const pasteFixtureOrigin = "https://pasteboard-pro.fixture.invalid";

async function waitForDevToolsUrl(process: ChildProcess, timeoutMs = 10_000) {
  let output = "";
  const stdout = process.stdout;
  const stderr = process.stderr;
  assert.ok(stdout && stderr, "Owned Chrome stdout/stderr pipes are required for readiness");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Chrome DevTools URL timed out: ${output}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Chrome exited before DevTools readiness: ${code}/${signal}; ${output}`));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stderr.off("data", onData);
      process.off("exit", onExit);
      if (error) reject(error); else resolve(value!);
    };
    stdout.on("data", onData);
    stderr.on("data", onData);
    process.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
  });
}

export async function targetWebSocketUrl(browserUrl: string, targetId: string) {
  const browser = new URL(browserUrl);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://${browser.hostname}:${browser.port}/json/list`);
    assert.equal(response.ok, true, "Owned Chrome target inventory must be readable");
    const targets = await response.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find(value => value.id === targetId);
    if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Owned Chrome target ${targetId} has no CDP endpoint before its deadline`);
}

export async function closePasteCdp(client: CdpClient, timeoutMs = 1000) {
  const socket = client.ws.socket as import("node:net").Socket;
  if (socket.destroyed) return { closed: true, forced: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeResult = await Promise.race([
    client.close().then(() => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closeResult && !socket.destroyed) socket.destroy();
  if (!socket.destroyed) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>(resolve => socket.once("close", resolve)),
        new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error("Owned CDP socket did not close after destroy")), 500); }),
      ]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
  }
  return { closed: socket.destroyed, forced: !closeResult };
}

export async function launchPasteBrowserSession(options: {
  tempRoot: string;
  env: Record<string, string>;
  targetEvents: TargetInfo[];
  destroyedTargets: string[];
  fixtureOrigin?: string;
}) {
  const fixtureOrigin = options.fixtureOrigin ?? pasteFixtureOrigin;
  const chromePath = await findChromePath();
  await access(chromePath);
  const profilePath = await mkdtemp(join(options.tempRoot, "chrome-profile-"));
  await mkdir(join(profilePath, "downloads"), { mode: 0o700 });
  let child: ChildProcess | undefined;
  let browser: CdpClient | undefined;
  let browserUrl: string | undefined;
  let harness: CdpClient | undefined;
  let harnessTargetId: string | undefined;
  const usedTargets = new Set<string>();
  const lifecycle: Record<string, unknown> = {
    binary: chromePath, profilePath, profileInitiallyEmpty: (await readdir(profilePath)).length === 1,
    processState: "not_spawned", browserPid: null, exitCode: null, exitSignal: null,
    profileState: "not_removed", targetEvents: options.targetEvents,
    browserOsHomeField: true, privateProfile: true, ambientCredentialsInherited: false,
    browserHomeBoundary: "Only HOME uses the OS account home and is not isolated; user-data-dir/downloads stay in the fixture temp root and ambient credentials are not inherited",
    fixtureOriginPermission: {
      origin: fixtureOrigin, permission: "loopbackNetwork", state: "not_requested",
      scope: "current private Chrome instance only; fixture origin only",
      classification: "browser fixture grant, not TaskRun or native OS permission",
    },
  };
  try {
    const chromeEnv = { ...options.env, HOME: userInfo().homedir };
    child = spawn(chromePath, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`,
      "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
      "--disable-extensions", "--disable-features=MediaRouter,Translate", "--disable-gpu",
      "--hide-scrollbars", "--mute-audio", "--no-default-browser-check", "--no-first-run", "about:blank",
    ], { env: chromeEnv, stdio: ["ignore", "pipe", "pipe"] });
    lifecycle.processState = "running";
    lifecycle.browserPid = child.pid ?? null;
    browserUrl = await waitForDevToolsUrl(child);
    browser = await CdpClient.connect(browserUrl);
    browser.on("Target.targetCreated", event => options.targetEvents.push({ ...event.targetInfo, eventKind: "created" }));
    browser.on("Target.targetInfoChanged", event => options.targetEvents.push({ ...event.targetInfo, eventKind: "changed" }));
    browser.on("Target.targetDestroyed", event => options.destroyedTargets.push(event.targetId));
    await browser.send("Target.setDiscoverTargets", { discover: true }, { timeoutMs: 5000 });
    const baselineInventory = await browser.send("Target.getTargets", {}, { timeoutMs: 5000 });
    const baselinePageTargets = (baselineInventory.targetInfos ?? []).filter((target: TargetInfo) => target.type === "page");
    assert.ok(baselinePageTargets.length > 0, "Private Chrome must expose its initial page target before harness creation");
    assert.deepEqual(baselinePageTargets.map((target: TargetInfo) => target.url), baselinePageTargets.map(() => "about:blank"),
      "Every Chrome page target present before harness creation must be the initial about:blank page");
    const baselinePageTargetIds = baselinePageTargets.map((target: TargetInfo) => target.targetId);
    lifecycle.baselinePageTargets = baselinePageTargets.map((target: TargetInfo) => ({ targetId: target.targetId, url: target.url }));
    await browser.send("Browser.setDownloadBehavior", { behavior: "deny", downloadPath: join(profilePath, "downloads") }, { timeoutMs: 5000 });
    try {
      await browser.send("Browser.grantPermissions", { origin: fixtureOrigin, permissions: ["loopbackNetwork"] }, { timeoutMs: 5000 });
      Object.assign(lifecycle.fixtureOriginPermission as Record<string, unknown>, { state: "granted" });
    } catch (error) {
      Object.assign(lifecycle.fixtureOriginPermission as Record<string, unknown>, { state: "grant_failed", error: String(error) });
      throw error;
    }
    const harnessUrl = await createPageWebSocketUrl(browserUrl);
    harness = await CdpClient.connect(harnessUrl);
    harnessTargetId = new URL(harnessUrl).pathname.split("/").at(-1);
    assert.ok(harnessTargetId, "Owned harness target id is required");
    await harness.send("Page.enable", {}, { timeoutMs: 5000 });
    await harness.send("Runtime.enable", {}, { timeoutMs: 5000 });
    await harness.send("Page.setDownloadBehavior", { behavior: "deny" }, { timeoutMs: 5000 }).catch(() => {});
    return {
      browser, browserUrl, harness, harnessTargetId, baselinePageTargetIds, lifecycle,
      async openChild() {
        const popupPromise = waitForTarget(options.targetEvents, info =>
          info.type === "page" && info.openerId === harnessTargetId && info.url === "about:blank"
          && info.targetId !== harnessTargetId && !usedTargets.has(info.targetId), 5000);
        const opened = await harness!.send("Runtime.evaluate", {
          expression: `(()=>{window.__pasteEditorChild=window.open('about:blank','atools-paste-editor-fixture');return !!window.__pasteEditorChild})()`,
          userGesture: true, returnByValue: true,
        }, { timeoutMs: 5000 });
        assert.equal(opened.result?.value, true, "Harness must create its one controlled editor document target");
        const target = await popupPromise;
        usedTargets.add(target.targetId);
        const page = await CdpClient.connect(await targetWebSocketUrl(browserUrl!, target.targetId));
        await page.send("Page.enable", {}, { timeoutMs: 5000 });
        await page.send("Runtime.enable", {}, { timeoutMs: 5000 });
        await page.send("Network.enable", {}, { timeoutMs: 5000 });
        return { target, page };
      },
      async close() {
        const failures: unknown[] = [];
        if (browser) {
          try {
            await browser.send("Browser.resetPermissions", {}, { timeoutMs: 5000 });
            Object.assign(lifecycle.fixtureOriginPermission as Record<string, unknown>, { resetState: "reset" });
          } catch (error) {
            Object.assign(lifecycle.fixtureOriginPermission as Record<string, unknown>, { resetState: "reset_failed", resetError: String(error) });
            failures.push(new Error(`Fixture-origin Browser permission reset failed: ${String(error)}`, { cause: error }));
          }
        }
        for (const [name, client] of [["harness", harness], ["browser", browser]] as const) {
          try { if (client) lifecycle[`${name}CdpClose`] = await closePasteCdp(client); }
          catch (error) { failures.push(new Error(`${name} CDP socket: ${String(error)}`)); }
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          if (!await waitForExit(child, 3000) && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            if (!await waitForExit(child, 1500)) failures.push(new Error(`Owned Chrome PID ${child.pid} did not exit after SIGKILL`));
          }
        }
        if (child) {
          lifecycle.exitCode = child.exitCode;
          lifecycle.exitSignal = child.signalCode;
          lifecycle.processState = child.exitCode !== null || child.signalCode !== null ? "exited" : "exit_unconfirmed";
        }
        if (lifecycle.processState === "exited") {
          await rm(profilePath, { recursive: true, force: true });
          lifecycle.profileState = "removed";
        }
        if (failures.length) throw new AggregateError(failures, "Owned Paste editor Chrome cleanup failed");
        return lifecycle;
      },
    };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try { if (browser) await closePasteCdp(browser); } catch {}
    try { if (harness) await closePasteCdp(harness); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (!await waitForExit(child, 3000) && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        const exited = await waitForExit(child, 1500);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          const message = `Owned Chrome PID ${child.pid ?? "unknown"} did not exit after SIGKILL`;
          lifecycle.cleanupFailure = message;
          cleanupFailures.push(new Error(message));
        }
      }
    }
    lifecycle.exitCode = child?.exitCode ?? null;
    lifecycle.exitSignal = child?.signalCode ?? null;
    lifecycle.processState = child && (child.exitCode !== null || child.signalCode !== null) ? "exited" : child ? "exit_unconfirmed" : "not_spawned";
    if (lifecycle.processState === "exited" || lifecycle.processState === "not_spawned") {
      await rm(profilePath, { recursive: true, force: true });
      lifecycle.profileState = "removed";
    } else {
      lifecycle.profileState = "preserved_for_unconfirmed_process_exit";
    }
    const startupError = error instanceof Error ? error : new Error(String(error), { cause: error });
    Object.assign(startupError, { atoolsChromeLifecycle: lifecycle });
    if (cleanupFailures.length) {
      const cleanupError = new AggregateError([startupError, ...cleanupFailures], "Chrome startup failed and cleanup could not be confirmed", { cause: startupError });
      Object.assign(cleanupError, { atoolsChromeLifecycle: lifecycle });
      throw cleanupError;
    }
    throw startupError;
  }
}

function waitForTarget(events: TargetInfo[], matches: (info: TargetInfo) => boolean, timeoutMs: number): Promise<TargetInfo> {
  return new Promise((resolve, reject) => {
    const existing = [...events].reverse().find(matches);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the controlled editor popup target")), timeoutMs);
    // target events are stored by launchPasteBrowserSession and polled below.
    const poll = setInterval(() => {
      const current = [...events].reverse().find(matches);
      if (current) finish(undefined, current);
    }, 10);
    const finish = (error?: Error, value?: TargetInfo) => {
      clearTimeout(timer); clearInterval(poll);
      if (error) reject(error); else resolve(value!);
    };
  });
}
