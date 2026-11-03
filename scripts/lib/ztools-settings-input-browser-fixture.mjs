import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { rendererFixtureTransportScript } from "../../tests/fixtures/ztools-renderer-host/fixture-transport.mjs";
import { createSettingsAliasBootstrap } from "./ztools-settings-alias-browser-fixture.mjs";

export const PAGEHIDE_WITNESS_PREFIX = "__atools_settings_pagehide_v1__:";

const INPUT_BYTES = 16 * 1024;
const PLACEHOLDER_BYTES = 512;
const PAGE_BYTES = 32 * 1024;
const UTF8 = new TextEncoder();
const SETTINGS_INPUT_KEYS = [
  "disable-commands", "pinned-commands", "super-panel-pinned", "global-shortcuts", "app-shortcuts",
];

function jsonBytes(value) {
  return UTF8.encode(JSON.stringify(value));
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nativeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createCommandSettingsDocument(appName, appPath) {
  return {
    "disable-commands": ["direct:app:/Applications/disabled-fixture.app"],
    "pinned-commands": [{
      type: "direct", subType: "app", name: "Pinned fixture application",
      path: "/Applications/pinned-fixture.app", icon: "",
    }],
    "super-panel-pinned": [{
      isFolder: true, name: "Input fixture folder", items: [{
        type: "direct", subType: "app", name: appName, path: appPath, icon: "",
      }],
    }],
    "global-shortcuts": [{ shortcut: "Alt+Shift+K", target: "builtin.fixture-command", enabled: true }],
    "app-shortcuts": [{
      appPath, appName, shortcut: "Alt+Shift+J", command: "fixture-command", enabled: true,
    }],
  };
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  assert.ok(index >= 0 && source.indexOf(before, index + before.length) < 0,
    `Expected one stable insertion point for ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

export function createMainSettingsInputBootstrap() {
  let source = rendererFixtureTransportScript();
  source = replaceOnce(source,
    '  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {',
    `  fixture.emitRendererSettingsEvent = (payload) => {
    if (!payload || payload.version !== 1 || typeof payload.sessionId !== "string") {
      throw new Error("Synthetic settings lifecycle event is invalid");
    }
    state.emittedEvents["atools://renderer-settings-view"] += 1;
    return deliver("atools://renderer-settings-view", payload);
  };
  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {`,
    "Main settings event fixture");
  return `${source}\n;(() => {
    const transport = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__;
    const originalInvoke = transport.invoke.bind(transport);
    let sequence = 0;
    const pending = new Map();
    const state = { requests: [], unresolved: 0, maxPayloadBytes: 0, maxReplyBytes: 0 };
    window.__ATOOLS_SETTINGS_INPUT_TESTING__ = {
      state,
      resolve(id, envelope) {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        state.unresolved = pending.size;
        if (envelope.ok) entry.resolve(envelope.value);
        else entry.reject(Object.assign(new Error(envelope.message || "Synthetic Native failure"), { code: envelope.code || "ERR_SYNTHETIC" }));
        return true;
      },
      snapshot() { return JSON.parse(JSON.stringify(state)); }
    };
    function nativeRequest(command, args) {
      const id = "main-" + (++sequence);
      const request = { id, command, args: args === undefined ? null : args };
      const payloadBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
      state.maxPayloadBytes = Math.max(state.maxPayloadBytes, payloadBytes);
      state.requests.push({ id, command, payloadBytes });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        state.unresolved = pending.size;
        window.__atoolsSettingsInputRpc(JSON.stringify(request));
      });
    }
    transport.invoke = function(command, args) {
      if (command === "open_renderer_settings" || command === "close_renderer_settings" ||
          command === "notify_renderer_settings_input") return nativeRequest(command, args);
      return originalInvoke(command, args);
    };
    window.addEventListener("unhandledrejection", event => {
      try { window.__atoolsSettingsInputRpc(JSON.stringify({
        kind: "unhandledrejection", reason: String(event.reason?.message || event.reason || "unhandled rejection").slice(0, 1200)
      })); } catch {}
    });
  })();`;
}

export function createChildSettingsInputBootstrap({
  fixtureBundle,
  aliases,
  documentKey,
  runId,
  bundleRevision,
  appName,
  appPath,
}) {
  let source = createSettingsAliasBootstrap({ fixtureBundle, aliases, documentKey, runId, appName, appPath });
  const runHash = createHash("sha256").update(runId).digest("hex");
  source = replaceOnce(source, JSON.stringify(runHash), JSON.stringify(bundleRevision), "child bundle revision");
  source = replaceOnce(source,
    "    const catalog = fixtureModule.createFixtureCommandCatalog(1024);",
    `    const catalog = fixtureModule.createFixtureCommandCatalog(1024);
    catalog.commands = catalog.commands.map((command, index) => ({
      ...command, name: index === 73 ? "Application 73" : "Fixture command " + index, icon: ""
    }));`,
    "synthetic 1024 command catalog");

  const document = createCommandSettingsDocument(appName, appPath);
  return `${source}\n;(() => {
    const config = window.__ATOOLS_SETTINGS_VIEW_CONFIG__;
    const pagehideWitnessKey = ${JSON.stringify(PAGEHIDE_WITNESS_PREFIX)} + config.sessionId;
    const fixture = window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.fixture;
    if (!fixture || !config) throw new Error("Synthetic settings transport bootstrap is incomplete");
    const originalInvoke = fixture.invoke;
    const settingsBytes = new TextEncoder().encode(JSON.stringify(${JSON.stringify(document)}));
    const operationCalls = [];
    const pageCalls = [];
    const customPages = new Map();
    const pending = new Map();
    let requestSequence = 0;
    let settingsReadCount = 0;
    let tokenSequence = 0;
    let maximumPayloadBytes = 0;
    let maximumReplyBytes = 0;
    let pagehideObserverInstalled = false;
    const copy = value => JSON.parse(JSON.stringify(value));
    const encodeBase64 = bytes => {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    function page(snapshotToken, offset) {
      const snapshot = customPages.get(snapshotToken);
      if (!snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.bytes.byteLength) {
        throw Object.assign(new Error("Synthetic command settings page offset rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
      }
      const nextOffset = Math.min(offset + ${PAGE_BYTES}, snapshot.bytes.byteLength);
      const reply = { version: 1, kind: "commandSettings", token: snapshotToken, offset, nextOffset,
        totalBytes: snapshot.bytes.byteLength, data: encodeBase64(snapshot.bytes.subarray(offset, nextOffset)) };
      pageCalls.push({ token: snapshotToken, read: snapshot.read, offset, nextOffset, totalBytes: snapshot.bytes.byteLength,
        replyBytes: new TextEncoder().encode(JSON.stringify(reply)).byteLength });
      return reply;
    }
    function requestNative(operation, payload) {
      const id = "child-" + (++requestSequence);
      const request = { id, operation, payload, sessionId: config.sessionId };
      maximumPayloadBytes = Math.max(maximumPayloadBytes,
        new TextEncoder().encode(JSON.stringify(request)).byteLength);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.__atoolsSettingsChildRpc(JSON.stringify(request));
      });
    }
    fixture.invoke = async (operation, payload, sessionId) => {
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      const invokeBytes = new TextEncoder().encode(JSON.stringify({ operation, payload, sessionId })).byteLength;
      maximumPayloadBytes = Math.max(maximumPayloadBytes, payloadBytes, invokeBytes);
      operationCalls.push({ operation, sessionId, payloadBytes, status: "pending" });
      const call = operationCalls.at(-1);
      try {
        let reply;
        if (operation === "readCommandSettings") {
          if (Object.keys(payload).length !== 0 || sessionId !== config.sessionId) {
            throw Object.assign(new Error("Synthetic command settings request rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
          }
          settingsReadCount += 1;
          customPages.clear();
          tokenSequence += 1;
          const token = "70000000-0000-4000-8000-" + tokenSequence.toString(16).padStart(12, "0");
          customPages.set(token, { sessionId, kind: "commandSettings", bytes: settingsBytes, read: settingsReadCount });
          reply = page(token, 0);
        } else if (operation === "readCommandDataPage" && payload?.kind === "commandSettings") {
          const snapshot = customPages.get(payload.token);
          if (!snapshot || snapshot.sessionId !== sessionId || sessionId !== config.sessionId || payload.token !== token ||
              Object.keys(payload).sort().join(",") !== "kind,offset,token") {
            throw Object.assign(new Error("Synthetic command settings page token rejected"), { code: "ERR_ATOOLS_SETTINGS_PROTOCOL" });
          }
          reply = page(payload.token, payload.offset);
        } else if (["updateSubInput", "close", "outAcknowledged", "readLocalShortcuts", "addLocalShortcut",
          "addLocalShortcutByPath", "deleteLocalShortcut", "updateLocalShortcutAlias", "openLocalShortcut",
          "deleteMissingLocalShortcuts"].includes(operation)) {
          reply = await requestNative(operation, payload);
        } else {
          reply = await originalInvoke(operation, payload, sessionId);
        }
        const replyBytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
        maximumReplyBytes = Math.max(maximumReplyBytes, replyBytes);
        call.status = "resolved";
        call.replyBytes = replyBytes;
        return copy(reply);
      } catch (error) {
        call.status = "rejected";
        call.errorCode = error?.code || "UNKNOWN";
        throw error;
      }
    };
    window.__ATOOLS_SETTINGS_INPUT_CHILD__ = {
      resolve(id, envelope) {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        if (envelope.ok) entry.resolve(envelope.value);
        else entry.reject(Object.assign(new Error(envelope.message || "Synthetic Native failure"), { code: envelope.code || "ERR_SYNTHETIC" }));
        return true;
      },
      snapshot() {
        return { config: copy(config), operationCalls: copy(operationCalls), pageCalls: copy(pageCalls),
          settingsReadCount, pendingCount: pending.size, maximumPayloadBytes, maximumReplyBytes,
          pagehideObserverInstalled,
          commandSettingsKeys: ${JSON.stringify(SETTINGS_INPUT_KEYS)},
          commandSettings: JSON.parse(new TextDecoder().decode(settingsBytes)) };
      },
      fixture: window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__
    };
    const sentinel = () => false;
    window.__ATOOLS_SETTINGS_DELIVER_INPUT__ = sentinel;
    window.__ATOOLS_SETTINGS_INPUT_SENTINEL__ = sentinel;
    document.addEventListener("DOMContentLoaded", () => {
      window.addEventListener("pagehide", event => {
        const witness = { version: 1, sessionId: config.sessionId,
          trustedEvent: event.isTrusted === true, observerInstalled: pagehideObserverInstalled,
          hookRestored: window.__ATOOLS_SETTINGS_DELIVER_INPUT__ === sentinel,
          outRestored: window.__ATOOLS_SETTINGS_DELIVER_OUT__ === undefined,
          pendingCount: window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot?.().pendingCount ?? null };
        try { sessionStorage.setItem(pagehideWitnessKey, JSON.stringify(witness)); } catch {}
        try { window.__atoolsSettingsChildRpc(JSON.stringify({ kind: "pagehide", ...witness })); } catch {}
      });
      pagehideObserverInstalled = true;
    }, { once: true });
    window.addEventListener("unhandledrejection", event => {
      try { window.__atoolsSettingsChildRpc(JSON.stringify({ kind: "unhandledrejection", sessionId: config.sessionId,
        reason: String(event.reason?.message || event.reason || "unhandled rejection").slice(0, 1200) })); } catch {}
    });
  })();`;
}

export function createSyntheticSettingsInputNativeState({ sessionId, bundleRevision }) {
  const state = {
    sessionId, bundleRevision, generation: 0, revision: 1, valueVersion: 0, sequence: 0,
    mainSequence: 0, visible: false, placeholder: "搜索", value: "", focus: false,
    closed: false, lastEvent: null, operationCalls: [], deliveries: [], rejected: [],
  };

  function packet(action) {
    return {
      version: 1, kind: "subInput", sessionId: state.sessionId, bundleRevision: state.bundleRevision,
      generation: state.generation, revision: state.revision, valueVersion: state.valueVersion,
      action, visible: state.visible, placeholder: state.placeholder, value: state.value, focus: state.focus,
    };
  }

  function changed(action) {
    state.revision += 1;
    state.lastEvent = packet(action);
    return state.lastEvent;
  }

  function reply(applied) {
    return { version: 1, generation: state.generation, revision: state.revision, valueVersion: state.valueVersion, applied };
  }

  function sequenceCanApply(value) {
    return Number.isSafeInteger(value) && value > state.sequence;
  }

  function reject(reason) {
    state.rejected.push(reason);
    return { reply: reply(false), packet: null, applied: false };
  }

  function acceptChildOperation(operation, payload) {
    if (state.closed || !["set", "remove", "value", "focus", "blur", "select"].includes(operation) ||
        !exactKeys(payload, operation === "set"
      ? ["action", "generation", "sequence", "placeholder", "focus"]
      : operation === "remove" ? ["action", "generation", "sequence"]
        : operation === "value" ? ["action", "generation", "sequence", "value"]
          : ["action", "generation", "sequence"]) || payload.action !== operation) return reject("invalid-child-operation");
    if (!Number.isSafeInteger(payload.generation) || payload.generation <= 0 || !sequenceCanApply(payload.sequence)) {
      return reject("stale-child-generation-or-sequence");
    }
    if ((operation === "set" || operation === "remove") && payload.generation <= state.generation) {
      return reject("stale-child-owner-generation");
    }
    if (operation === "set" && (typeof payload.placeholder !== "string" ||
        UTF8.encode(payload.placeholder).byteLength > PLACEHOLDER_BYTES || typeof payload.focus !== "boolean")) {
      return reject("invalid-child-set-shape");
    }
    if (!["set", "remove"].includes(operation) && payload.generation !== state.generation) {
      return reject("child-operation-owner-is-stale");
    }
    if (operation === "value" && (typeof payload.value !== "string" || UTF8.encode(payload.value).byteLength > INPUT_BYTES)) {
      return reject("invalid-child-value");
    }

    if ((operation === "focus" || operation === "select") && !state.visible) {
      state.sequence = payload.sequence;
      state.rejected.push(`invisible-${operation}-control`);
      return { reply: reply(false), packet: null, applied: false };
    }
    state.sequence = payload.sequence;
    let eventAction = operation;
    if (operation === "set" || operation === "remove") {
      state.generation = payload.generation;
      if (operation === "set") {
        state.visible = true;
        state.placeholder = payload.placeholder || "搜索";
        state.focus = payload.focus;
      } else {
        state.visible = false;
        state.focus = false;
      }
    } else {
      if (operation === "value") {
        state.value = payload.value;
        state.valueVersion += 1;
        state.focus = true;
      } else {
        state.focus = operation === "focus" || operation === "select";
      }
    }
    const event = changed(eventAction);
    state.operationCalls.push({ source: "child", operation, applied: true, packet: event });
    return { reply: reply(true), packet: event, applied: true };
  }

  function acceptMainInput(request) {
    if (state.closed || !exactKeys(request, ["sessionId", "bundleRevision", "generation", "valueVersion", "sequence", "text"]) ||
        request.sessionId !== state.sessionId || request.bundleRevision !== state.bundleRevision ||
        request.generation !== state.generation || request.valueVersion !== state.valueVersion || !state.visible ||
        !Number.isSafeInteger(request.sequence) || request.sequence <= state.mainSequence ||
        typeof request.text !== "string" || UTF8.encode(request.text).byteLength > INPUT_BYTES) {
      state.rejected.push("invalid-or-stale-main-input");
      return { reply: reply(false), delivery: null, applied: false };
    }
    state.mainSequence = request.sequence;
    state.value = request.text;
    const event = changed("value");
    const delivery = {
      version: 1, sessionId: state.sessionId, bundleRevision: state.bundleRevision,
      generation: state.generation, revision: state.revision, text: state.value,
    };
    state.deliveries.push({ source: "main", revision: state.revision, textBytes: UTF8.encode(state.value).byteLength });
    state.operationCalls.push({ source: "main", operation: "notify_renderer_settings_input", applied: true, packet: event });
    return { reply: reply(true), delivery, applied: true };
  }

  function markClosed() {
    state.closed = true;
    state.visible = false;
    state.placeholder = "";
    state.value = "";
    state.focus = false;
    state.lastEvent = null;
    return { version: 1, sessionId: state.sessionId, closed: true };
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return Object.freeze({ state, packet, acceptChildOperation, acceptMainInput, markClosed, snapshot });
}

