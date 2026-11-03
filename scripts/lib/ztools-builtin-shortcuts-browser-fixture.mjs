import assert from "node:assert/strict";
import { createGeneral } from "./ztools-settings-alias-browser-fixture.mjs";

const FIELD = "builtinAppShortcutsEnabled";
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failure = (code, message) => Object.assign(new Error(message), { code });

function installMain(initial) {
  const transport = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__;
  const original = transport.invoke.bind(transport);
  let release;
  const state = { held: false, released: false, startup: null, events: 0 };
  window.__ATOOLS_BUILTIN_SHORTCUTS_MAIN__ = {
    snapshot: () => structuredClone(state),
    accept(raw) { state.events += 1; return window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitBuiltinGeneral(raw); },
    releaseStartup() { if (!release) return false; release(); release = null; state.released = true; return true; },
  };
  transport.invoke = async (command, args) => {
    const reply = await original(command, args);
    if (command !== "get_ztools_renderer_settings") return reply;
    const general = JSON.parse(reply.settings["settings-general"]);
    reply.settings["settings-general"] = JSON.stringify({ ...general, builtinAppShortcutsEnabled: initial });
    state.startup = structuredClone(reply.settings["settings-general"]);
    state.held = true;
    await new Promise(resolve => { release = resolve; });
    state.held = false;
    return reply;
  };
}

function installChild() {
  function assertBuiltinCapability(ready) {
    if (ready.capabilities.editableGeneralFields.filter(field => field === "builtinAppShortcutsEnabled").length !== 1) {
      throw new Error("Expected exactly one builtin shortcut General capability");
    }
  }
  const original = window.__TAURI__.core.invoke;
  const config = window.__ATOOLS_SETTINGS_VIEW_CONFIG__;
  const pending = new Map();
  let sequence = 0;
  function request(operation, payload) {
    const id = `builtin-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.__atoolsSettingsChildRpc(JSON.stringify({ kind: "r69-builtin-shortcuts", id, operation, payload, sessionId: config.sessionId }));
    });
  }
  window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__ = {
    pendingCount: () => pending.size,
    resolve(id, envelope) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      if (envelope.ok) entry.resolve(envelope.value);
      else entry.reject(Object.assign(new Error(envelope.message), { code: envelope.code }));
      return true;
    },
  };
  window.__TAURI__.core.invoke = async (command, args) => {
    if (command !== "call_renderer_settings") return original(command, args);
    if (args.operation === "ready") {
      const ready = await original(command, args);
      ready.general = await request("readGeneral", {});
      assertBuiltinCapability(ready);
      return ready;
    }
    if (["readGeneral", "patchGeneral"].includes(args.operation)) return request(args.operation, args.payload);
    return original(command, args);
  };
}

/** Synthetic transport only. Production Rust/SQLite acceptance is reported separately. */
export function createBuiltinShortcutsBrowserFixture() {
  let raw = { search: true, esc: true, closePlugin: false, killPlugin: true, future: { keep: "opaque" } };
  let revision = 1;
  let nextFailure = null;
  const calls = [];
  let mutations = 0;
  let notifications = 0;
  const projected = () => ({ search: object(raw) && typeof raw.search === "boolean" ? raw.search : true,
    esc: object(raw) && typeof raw.esc === "boolean" ? raw.esc : true });
  const read = () => ({ revision: `r69-revision-${revision}`, value: { ...createGeneral(), [FIELD]: projected() } });
  return {
    read,
    snapshot: () => ({ raw: copy(raw), revision, calls: copy(calls), mutations, notifications }),
    failNext(code) { nextFailure = code; },
    replaceRaw(value) { raw = copy(value); revision += 1; },
    decorateMain(source) {
      const anchor = '  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {';
      assert.equal(source.split(anchor).length, 2, "Main General fixture insertion must be unique");
      return source.replace(anchor, `  fixture.emitBuiltinGeneral = raw => {
        state.emittedEvents["atools://renderer-general-settings"] += 1;
        return deliver("atools://renderer-general-settings", {version:1,raw});
      };\n${anchor}`) + `\n;(${installMain.toString()})(${JSON.stringify(projected())});`;
    },
    decorateChild(source) { return `${source}\n;(${installChild.toString()})();`; },
    async handle(message, { sessionId, publish }) {
      const call = { operation: message.operation, payload: copy(message.payload), sessionId: message.sessionId, status: "pending" };
      calls.push(call);
      try {
        if (message.sessionId !== sessionId) throw failure("ERR_ATOOLS_SETTINGS_SESSION", "Synthetic stale Child session rejected");
        let value;
        if (message.operation === "readGeneral" && exact(message.payload, [])) value = read();
        else if (message.operation === "patchGeneral") {
          const payload = message.payload;
          if (!exact(payload, ["revision", "changes"]) || !exact(payload.changes, [FIELD]) || !object(payload.changes[FIELD])
              || !Object.keys(payload.changes[FIELD]).length || Object.entries(payload.changes[FIELD]).some(([key, enabled]) =>
                !["search", "esc"].includes(key) || typeof enabled !== "boolean")) {
            throw failure("GENERAL_SETTINGS_PATCH_FAILED", "Synthetic invalid builtin intent rejected");
          }
          if (nextFailure === "SETTINGS_REVISION_CONFLICT") revision += 1;
          if (nextFailure) { const code = nextFailure; nextFailure = null; throw failure(code, `R69 injected ${code}`); }
          if (payload.revision !== read().revision) throw failure("SETTINGS_REVISION_CONFLICT", "Synthetic stale General revision rejected");
          if (!object(raw)) throw failure("GENERAL_SETTINGS_PATCH_FAILED", "Synthetic stored nonobject rejected without rewriting");
          const next = { ...raw, ...payload.changes[FIELD] };
          const changed = JSON.stringify(next) !== JSON.stringify(raw);
          if (changed) { raw = next; revision += 1; mutations += 1; notifications += 1; await publish(JSON.stringify({ [FIELD]: projected() })); }
          value = { ...read(), notificationDelivered: true };
        } else throw failure("ERR_ATOOLS_SETTINGS_UNSUPPORTED", "Synthetic operation outside builtin slice");
        call.status = "resolved";
        return { ok: true, value };
      } catch (error) {
        call.status = "rejected"; call.code = error.code;
        return { ok: false, code: error.code || "GENERAL_SETTINGS_PATCH_FAILED", message: error.message };
      }
    },
  };
}
