import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

let bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("attachment-metadata-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("attachment-metadata-test-feature"));

const listeners = new Map();
const attachmentDocs = new Map();
const invokeCalls = [];

const windowStub = {
  parent: {
    postMessage(message) {
      if (!message?.__ipc_call__) return;
      void windowStub.__TAURI_INTERNALS__.invoke(message.cmd, message.args)
        .then((result) => {
          const callbacks = listeners.get("message") || [];
          callbacks.forEach((callback) => callback({
            data: { __ipc_response__: true, reqId: message.reqId, result },
          }));
        })
        .catch((error) => {
          const callbacks = listeners.get("message") || [];
          callbacks.forEach((callback) => callback({
            data: { __ipc_response__: true, reqId: message.reqId, error: String(error) },
          }));
        });
    },
  },
  top: {},
  __TAURI_INTERNALS__: {
    async invoke(cmd, args = {}) {
      invokeCalls.push({ cmd, args });
      if (cmd === "put_plugin_data") {
        attachmentDocs.set(args.doc._id, args.doc);
        return { ok: true, id: args.doc._id };
      }
      if (cmd === "get_plugin_data_item") {
        return attachmentDocs.get(args.docId) || null;
      }
      return null;
    },
  },
  addEventListener(type, cb) {
    const list = listeners.get(type) || [];
    list.push(cb);
    listeners.set(type, list);
  },
  dispatchEvent(event) {
    const list = listeners.get(event.type) || [];
    list.forEach((cb) => cb(event));
  },
  matchMedia() {
    return { matches: false };
  },
};
windowStub.parent.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;
windowStub.top.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;

class EventStub {
  constructor(type) {
    this.type = type;
  }
}

const context = vm.createContext({
  window: windowStub,
  document: {
    readyState: "complete",
    addEventListener() {},
  },
  navigator: { platform: "MacIntel" },
  Event: EventStub,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

assert.equal(
  typeof windowStub.utools.db.getAttachmentType,
  "function",
  "utools.db.getAttachmentType should be exposed",
);
assert.equal(
  typeof windowStub.utools.db.replicateStateFromCloud,
  "function",
  "utools.db.replicateStateFromCloud should be exposed",
);
assert.equal(
  windowStub.utools.db.promises.getAttachmentType,
  windowStub.utools.db.getAttachmentType,
  "promises bridge should expose getAttachmentType",
);
assert.equal(
  windowStub.utools.db.promises.replicateStateFromCloud,
  windowStub.utools.db.replicateStateFromCloud,
  "promises bridge should expose replicateStateFromCloud",
);

const postResult = await windowStub.utools.db.postAttachment("avatar", "image-bytes", "image/png");
assert.equal(postResult.ok, true);
assert.equal(postResult.id, "avatar");
assert.equal(postResult.name, "attachment");
assert.equal(await windowStub.utools.db.getAttachment("avatar"), "image-bytes");
assert.equal(await windowStub.utools.db.getAttachmentType("avatar"), "image/png");
assert.equal(await windowStub.utools.db.promises.getAttachmentType("avatar"), "image/png");
assert.equal(await windowStub.utools.db.getAttachmentType("missing"), null);
await assert.rejects(
  windowStub.utools.db.getAttachmentType(),
  /getAttachmentType missing document id/,
);

assert.equal(
  await windowStub.utools.db.replicateStateFromCloud(),
  null,
  "ATools local plugin DB should report no uTools cloud sync state",
);
assert.equal(await windowStub.utools.db.promises.replicateStateFromCloud(), null);

assert.ok(
  invokeCalls.some((call) => call.cmd === "get_plugin_data_item" && call.args.docId === "__attachment__:avatar:attachment"),
  "getAttachmentType should read the same attachment metadata document as getAttachment",
);
assert.match(componentSource, /function _getAttachmentType/);
assert.match(componentSource, /getAttachmentType: function\(\)/);
assert.match(componentSource, /replicateStateFromCloud: function\(\)/);
