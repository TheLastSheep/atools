import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { delay, formatConsoleArgs } from "../chrome-cdp-smoke-utils.mjs";
import {
  createChildSettingsInputBootstrap,
  createSyntheticSettingsInputNativeState,
} from "./ztools-settings-input-browser-fixture.mjs";
import { createSettingsAliasSeed } from "./ztools-settings-alias-browser-fixture.mjs";

export function createSettingsInputBrowserRuntime(context) {
  const {
    report, currentDocument, pendingNetwork, pendingNative, pageWhitelist,
    server, mainPage, childPage, outputDir, runId,
    APP_NAME, APP_PATH, APP_COMMAND_ID, PLUGIN_LOGO,
  } = context;
  let childDriver = null;
  let activeSession = null;
  let lastClosedSession = null;
  let inputState = null;
  let childInjectionId = null;
  let fixtureBundle = context.fixtureBundle;
  let openedBy = null;
  let expectedConflictSeen = false;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function recordCall(command, payload, status, { channel, id, sessionId = null }) {
  const request = channel === "main"
    ? { id, command, args: payload ?? null }
    : { id, operation: command, payload: payload ?? null, sessionId };
  const payloadBytes = Buffer.byteLength(JSON.stringify(request));
  report.nativeInput.maxPayloadBytes = Math.max(report.nativeInput.maxPayloadBytes, payloadBytes);
  report.nativeInput.calls.push({ command, payloadBytes, status, channel });
}

async function evaluate(page, expression, timeoutMs = 10000) {
  const result = await page.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, { timeoutMs });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  }
  return result.result.value;
}

async function waitFor(page, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, `Boolean((${expression}))`, 3000)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${expression}`);
}

async function resolveBinding(page, target, id, envelope) {
  const expression = `${target}.resolve(${JSON.stringify(id)}, ${JSON.stringify(envelope)})`;
  await evaluate(page, expression, 5000);
}

function eventDocument(pageName) {
  return currentDocument[pageName];
}

function recordPageEvents(page, pageName) {
  page.on("Runtime.exceptionThrown", (event) => {
    const details = event.exceptionDetails || {};
    report.console.exceptions.push({
      page: pageName, document: eventDocument(pageName),
      message: (details.exception?.description || details.text || "runtime exception").slice(0, 1600),
    });
  });
  page.on("Runtime.consoleAPICalled", (event) => {
    const text = formatConsoleArgs(event.args).slice(0, 1600);
    const item = { page: pageName, document: eventDocument(pageName), type: event.type, text };
    if (event.type === "warning" || event.type === "warn") report.console.warnings.push(item);
    else if (["error", "assert"].includes(event.type)) {
      report.console.errors.push(item);
      if (expectedConflictSeen && text.startsWith("保存指令别名失败:") && text.includes("设置已变化，请关闭并重新打开。")) {
        report.console.expectedAliasConflict.push(item);
      }
    }
  });
  page.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url);
    const generatedFavicon = event.request.url === `${server.origin}/favicon.ico` &&
      event.request.method === "GET";
    report.network.requests.push({
      page: pageName, origin: url.origin, path: url.pathname, method: event.request.method,
      resourceType: event.type || null,
      ...(generatedFavicon ? { browserGeneratedFavicon: true } : {}),
    });
  });
  page.on("Network.loadingFailed", (event) => {
    const item = { page: pageName, error: event.errorText || "request failed", blockedReason: event.blockedReason || null };
    report.network.failures.push(item);
  });
  page.on("Fetch.requestPaused", (event) => {
    const work = (async () => {
      const url = new URL(event.request.url);
      const prefix = url.pathname.startsWith("/main/") || url.pathname === "/main" ? "main"
        : url.pathname.startsWith("/setting/") || url.pathname === "/setting" ? "setting" : "";
      const relativePath = prefix ? (url.pathname === `/${prefix}` || url.pathname === `/${prefix}/`
        ? "index.html" : url.pathname.slice(prefix.length + 2)) : "";
      const requestPath = prefix ? `/${prefix}/${relativePath}` : url.pathname;
      const exactGeneratedFavicon = requestPath === "/favicon.ico" &&
        event.request.url === `${server.origin}/favicon.ico`;
      const retiredPath = new URL(server.retiredUrl).pathname;
      const exactRetiredTarget = pageName === "child" && requestPath === retiredPath &&
        event.request.url === server.retiredUrl;
      const allowed = url.origin === server.origin && event.request.method === "GET" &&
        pageWhitelist.has(requestPath) && (requestPath !== "/favicon.ico" || exactGeneratedFavicon) &&
        (requestPath !== retiredPath || exactRetiredTarget);
      const record = { page: pageName, origin: url.origin, path: url.pathname, method: event.request.method, allowed };
      if (allowed) {
        await page.send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 7000 });
      } else {
        report.network.denied.push(record);
        if (url.origin !== server.origin) report.network.externalAttempts.push(record);
        await page.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 7000 });
      }
    })().catch((error) => report.cleanup.errors.push(`Fetch ${pageName}: ${errorText(error)}`))
      .finally(() => pendingNetwork.delete(work));
    pendingNetwork.add(work);
  });
}

async function setupPage(page, pageName, bindingName, bindingHandler) {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.send("Runtime.addBinding", { name: bindingName });
  report.cleanup.bindings[pageName] = "added";
  page.on("Runtime.bindingCalled", (event) => {
    if (event.name !== bindingName) return;
    const work = Promise.resolve().then(async () => {
      let message;
      try { message = JSON.parse(event.payload); }
      catch { throw new Error(`${pageName} runner binding received invalid JSON`); }
      await bindingHandler(message);
    }).catch((error) => report.cleanup.errors.push(`${pageName} binding: ${errorText(error)}`))
      .finally(() => pendingNative.delete(work));
    pendingNative.add(work);
  });
  recordPageEvents(page, pageName);
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

async function emitMainEvent(payload) {
  assert.ok(mainPage, "Main renderer page must be available to receive synthetic lifecycle events");
  return evaluate(mainPage,
    `window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.emitRendererSettingsEvent?.(${JSON.stringify(payload)}) ?? false`);
}

async function emitLifecycle(phase, session) {
  const payload = { version: 1, sessionId: session.sessionId, phase };
  if (phase === "opened") {
    payload.plugin = {
      name: "setting", title: "设置", logo: PLUGIN_LOGO, path: "atools:internal/setting",
      cmdName: "设置", subInputPlaceholder: "搜索", subInputVisible: false,
    };
  }
  await emitMainEvent(payload);
  report.nativeInput.calls.push({ command: `lifecycle:${phase}`, sessionId: session.sessionId, payloadBytes: Buffer.byteLength(JSON.stringify(payload)) });
}

function createFreshSession() {
  const runUuid = randomUUID();
  const sessionId = runUuid.replaceAll("-", "");
  const bundleRevision = createHash("sha256")
    .update("ATools settings dist\0")
    .update(report.sourceIdentity.before.settings.dist.sha256)
    .update("\0")
    .update(report.sourceIdentity.before.settings.sources.sha256)
    .digest("hex");
  return { runUuid, sessionId, bundleRevision, state: createSyntheticSettingsInputNativeState({ sessionId, bundleRevision }) };
}

async function mainInputValue() {
  return evaluate(mainPage, "document.querySelector('.search-input')?.value ?? null");
}

async function deliverChildInput(delivery, session) {
  if (!childPage || !session || activeSession !== session || session.state.state.closed) return false;
  const accepted = await evaluate(childPage,
    `window.__ATOOLS_SETTINGS_DELIVER_INPUT__?.(${JSON.stringify(delivery)}) ?? false`, 5000);
  session.state.state.deliveries.push({ source: "native-to-child", revision: delivery.revision, accepted: accepted === true });
  return accepted === true;
}

async function dispatchInputEvent(event, session) {
  if (!event || !session || activeSession !== session) return false;
  const delivered = await emitMainEvent(event);
  session.state.state.operationCalls.push({ source: "native-to-main-event", action: event.action, revision: event.revision, delivered });
  return delivered;
}

async function replyFromNative(page, globalName, id, result) {
  const envelope = result?.error
    ? { ok: false, code: result.error.code || "ERR_SYNTHETIC", message: result.error.message }
    : { ok: true, value: result?.value };
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  report.nativeInput.maxReplyBytes = Math.max(report.nativeInput.maxReplyBytes, bytes);
  await resolveBinding(page, globalName, id, envelope);
}

async function handleClose(session, reason, source) {
  if (!session || activeSession !== session || session.state.state.closed) {
    throw Object.assign(new Error("No active synthetic settings session"), { code: "ERR_ATOOLS_SETTINGS_SESSION" });
  }
  if (!new Set(["main-hide", "child-out", "escape"]).has(reason)) {
    throw Object.assign(new Error("Synthetic close reason rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
  }
  const receipt = session.state.markClosed();
  const closedState = session.state.snapshot();
  assert.equal(closedState.visible, false, "Closing the synthetic owner must hide SubInput");
  assert.equal(closedState.placeholder, "", "Closing the synthetic owner must clear its placeholder");
  assert.equal(closedState.value, "", "Closing the synthetic owner must clear its text");
  assert.equal(closedState.focus, false, "Closing the synthetic owner must clear focus state");
  session.closedAt = new Date().toISOString();
  session.closeSource = source;
  await emitLifecycle("closed", session);
  if (reason !== "main-hide") await emitLifecycle("back-to-search", session);
  try {
    await evaluate(childPage, `window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.fixture?.closeSession?.(${JSON.stringify(session.sessionId)}) ?? false`, 3000);
  } catch {}
  lastClosedSession = session;
  activeSession = null;
  inputState = null;
  report.sessions.push({
    sessionId: session.sessionId, bundleRevision: session.bundleRevision,
    openedAt: session.openedAt, closedAt: session.closedAt, closeSource: source,
    nativeInput: session.state.snapshot(), pagehide: null,
  });
  return receipt;
}

async function navigateChildForSession(session, priorInjectionId) {
  const bootstrap = createChildSettingsInputBootstrap({
    fixtureBundle: fixtureBundle.source,
    aliases: createSettingsAliasSeed(APP_COMMAND_ID),
    documentKey: `${runId}:${session.sessionId}`,
    runId: session.runUuid,
    bundleRevision: session.bundleRevision,
    appName: APP_NAME,
    appPath: APP_PATH,
  });
  if (priorInjectionId) await childPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: priorInjectionId });
  const injection = await childPage.send("Page.addScriptToEvaluateOnNewDocument", {
    source: context.builtinShortcuts ? context.builtinShortcuts.decorateChild(bootstrap) : bootstrap,
  });
  childInjectionId = injection.identifier;
  assert.ok(childInjectionId, "Child synthetic transport must be installed before the original Vue entry script");
  const url = `${server.origin}/setting/index.html#/allCommands`;
  const current = await evaluate(childPage, "location.href");
  currentDocument.child = `session-${session.sessionId.slice(0, 8)}:allCommands`;
  const load = childPage.waitForEvent("Page.loadEventFired", 20000);
  if (current.startsWith(`${server.origin}/setting/index.html`)) {
    if (current !== url) await childPage.send("Page.navigate", { url });
    await childPage.send("Page.reload", { ignoreCache: true });
  } else {
    await childPage.send("Page.navigate", { url });
  }
  await load;
  await waitFor(childPage,
    `window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().calls?.some(call => call.operation === "ready") && document.querySelector(".sources-panel")`,
    "original Child command page and ready handshake");
  await waitFor(childPage,
    `document.querySelectorAll(".card.command-card").length > 0`, "original Child command catalog");
  const visibleDeadline = Date.now() + 12000;
  while (Date.now() < visibleDeadline && !session.state.state.visible) await delay(40);
  assert.equal(session.state.state.visible, true, "Original Child route must register its SubInput owner");
  await emitLifecycle("loaded", session);
  session.openedAt = new Date().toISOString();
  return childInjectionId;
}

async function openChild(source) {
  if (activeSession) throw Object.assign(new Error("A settings child session is already active"), { code: "ERR_ATOOLS_SETTINGS_SESSION" });
  const session = createFreshSession();
  activeSession = session;
  inputState = session.state;
  session.openSource = source;
  await emitLifecycle("placeholder", session);
  await emitLifecycle("opened", session);
  childInjectionId = await navigateChildForSession(session, childInjectionId);
  report.sessions.push({
    sessionId: session.sessionId, bundleRevision: session.bundleRevision,
    openedAt: session.openedAt, openSource: source, childRoute: "#/allCommands",
  });
  return { version: 1, sessionId: session.sessionId };
}

async function handleMainCommand(message) {
  if (message.kind === "unhandledrejection") {
    report.console.unhandled.push({ page: "main", document: eventDocument("main"), reason: message.reason });
    return;
  }
  const { id, command, args } = message;
  if (typeof id !== "string" || typeof command !== "string") throw new Error("Invalid Main binding request");
  if (command === "open_renderer_settings") {
    if (args !== null) throw Object.assign(new Error("Main open request must have no payload"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
    recordCall(command, args, "started", { channel: "main", id });
    const value = await openChild(openedBy || "original-main-cmd-comma");
    await replyFromNative(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__", id, { value });
    return;
  }
  if (command === "close_renderer_settings") {
    recordCall(command, args, "started", { channel: "main", id });
    if (!args || Object.keys(args).sort().join(",") !== "reason,sessionId" || args.sessionId !== activeSession?.sessionId) {
      throw Object.assign(new Error("Main close request does not match the active session"), { code: "ERR_ATOOLS_SETTINGS_SESSION" });
    }
    const value = await handleClose(activeSession, args.reason, "main-hide");
    await replyFromNative(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__", id, { value });
    return;
  }
  if (command === "notify_renderer_settings_input") {
    recordCall(command, args, "started", { channel: "main", id });
    if (!args || Object.keys(args).length !== 1 || !args.request || !activeSession) {
      throw Object.assign(new Error("Main input request is invalid"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
    }
    const request = args.request;
    const result = activeSession.state.acceptMainInput(request);
    if (result.applied) await deliverChildInput(result.delivery, activeSession);
    report.nativeInput.calls.at(-1).status = result.applied ? "applied" : "rejected";
    report.nativeInput.calls.at(-1).generation = request.generation;
    await replyFromNative(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__", id, { value: result.reply });
    return;
  }
  throw Object.assign(new Error(`Synthetic Main transport rejected ${command}`), { code: "ERR_ATOOLS_SETTINGS_UNSUPPORTED" });
}

async function handleChildOperation(message) {
  if (message.kind === "unhandledrejection") {
    report.console.unhandled.push({ page: "child", document: eventDocument("child"), reason: message.reason });
    return;
  }
  if (message.kind === "pagehide") {
    const observed = {
      sessionId: message.sessionId, hookRestored: message.hookRestored === true,
      outRestored: message.outRestored === true, pendingCount: message.pendingCount ?? null,
      trustedEvent: message.trustedEvent === true, observerInstalled: message.observerInstalled === true,
      witnessChannel: "runtime-binding",
    };
    report.documents.push({ page: "child", stage: "pagehide-dispose", ...observed });
    return;
  }
  if (typeof message.id !== "string" || typeof message.operation !== "string" || !activeSession ||
      message.sessionId !== activeSession.sessionId) {
    throw Object.assign(new Error("Child request belongs to no live session"), { code: "ERR_ATOOLS_SETTINGS_SESSION" });
  }
  const operation = message.operation;
  if (context.localLaunch?.handles(operation)) {
    const value = await context.localLaunch.handle(message, {
      publish: (items, revision) => evaluate(mainPage,
        `window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.accept(${JSON.stringify(items)},${revision})`),
    });
    recordCall(operation, message.payload, "resolved", { channel: "child", id: message.id, sessionId: message.sessionId });
    await replyFromNative(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__", message.id, { value });
    return;
  }
  if (operation === "updateSubInput") {
    const result = activeSession.state.acceptChildOperation(message.payload?.action, message.payload);
    if (result.packet) {
      await dispatchInputEvent(result.packet, activeSession);
      if (result.packet.action === "set" || result.packet.action === "value") {
        const delivery = {
          version: 1, sessionId: result.packet.sessionId, bundleRevision: result.packet.bundleRevision,
          generation: result.packet.generation, revision: result.packet.revision, text: result.packet.value,
        };
        await deliverChildInput(delivery, activeSession);
      }
    }
    recordCall(operation, message.payload, result.applied ? "applied" : "rejected",
      { channel: "child", id: message.id, sessionId: message.sessionId });
    await replyFromNative(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__", message.id, { value: result.reply });
    return;
  }
  if (operation === "close") {
    if (!message.payload || Object.keys(message.payload).length !== 1 || !["child-out", "escape"].includes(message.payload.reason)) {
      throw Object.assign(new Error("Child close payload rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
    }
    recordCall(operation, message.payload, "closed", { channel: "child", id: message.id, sessionId: message.sessionId });
    const value = await handleClose(activeSession, message.payload.reason, "child-out");
    await replyFromNative(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__", message.id, { value });
    return;
  }
  if (operation === "outAcknowledged") {
    if (!message.payload || Object.keys(message.payload).length !== 0) {
      throw Object.assign(new Error("Child out acknowledgement payload rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
    }
    await replyFromNative(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__", message.id, { value: { acknowledged: true } });
    return;
  }
  throw Object.assign(new Error(`Synthetic Child transport rejected ${operation}`), { code: "ERR_ATOOLS_SETTINGS_UNSUPPORTED" });
}

async function captureScreenshot(page, name, document) {
  const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, { timeoutMs: 12000 });
  const bytes = Buffer.from(result.data, "base64");
  const file = `${name}.png`;
  await writeFile(join(outputDir, file), bytes, { flag: "wx" });
  report.screenshots.push({
    file, page: name.startsWith("main") ? "main" : "child", document,
    bytes: bytes.byteLength, sha256: sha256(bytes),
    width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
  });
}

async function snapshotPage(page, pageName, label) {
  if (pageName === "child" && childDriver) {
    const snapshot = await childDriver.visibleDomSnapshot(label);
    report.documents.push({ page: pageName, stage: label, url: snapshot.url, title: snapshot.title, bodyText: snapshot.bodyText });
    return snapshot;
  }
  const snapshot = await evaluate(page, `(() => {
    const visible = element => {
      const style=getComputedStyle(element), rect=element.getBoundingClientRect();
      return style.display!=="none" && style.visibility!=="hidden" && Number(style.opacity)!==0 && rect.width>0 && rect.height>0;
    };
    const text = element => (element.innerText || element.textContent || "").replace(/\\s+/g," ").trim();
    return {url:location.href,title:document.title,bodyText:(document.body?.innerText||"").slice(0,16000),
      elements:Array.from(document.querySelectorAll("button,a,input,[role],.search-input,.placeholder-text"))
        .slice(0,300).map(element=>({tag:element.tagName.toLowerCase(),role:element.getAttribute("role"),
          type:element.getAttribute("type"),className:typeof element.className==="string"?element.className:"",
          text:text(element).slice(0,200),value:"value" in element?String(element.value).slice(0,240):null,
          placeholder:element.getAttribute("placeholder"),visible:visible(element)}))};
  })()`);
  report.domDiagnostics.push({ page: pageName, label, ...snapshot });
  return snapshot;
}

async function settleNetwork(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pendingNetwork.size) {
    await Promise.all([...pendingNetwork]);
    if (!pendingNetwork.size) return;
  }
  report.network.pending = pendingNetwork.size;
  assert.equal(pendingNetwork.size, 0, "Owned page network requests must finish before cleanup");
}

function countRendererCalls(snapshot, command) {
  return snapshot.calls.filter((call) => call.command === command).length;
}


  return {
    evaluate, waitFor, setupPage, emitMainEvent, emitLifecycle, mainInputValue,
    dispatchInputEvent, handleMainCommand, handleChildOperation, captureScreenshot,
    snapshotPage, settleNetwork, countRendererCalls,
    setChildDriver(value) { childDriver = value; },
    setOpenedBy(value) { openedBy = value; },
    markExpectedConflict() { expectedConflictSeen = true; },
    clearChildInjection() { childInjectionId = null; },
    get activeSession() { return activeSession; },
    get lastClosedSession() { return lastClosedSession; },
    get childInjectionId() { return childInjectionId; },
    get pendingNative() { return pendingNative; },
    get pendingNetwork() { return pendingNetwork; },
  };
}
