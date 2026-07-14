import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const normalize = (value) => JSON.parse(JSON.stringify(value));

function loadJsonPlugin(preloadSource) {
  const handlers = {
    enter: null,
    subInput: null,
  };
  const outputs = [];
  const subInputs = [];
  const sandbox = {
    console,
    utools: {
      onPluginEnter(callback) {
        handlers.enter = callback;
      },
      onSubInput(callback) {
        handlers.subInput = callback;
      },
      outPlugin(payload = {}) {
        outputs.push(payload);
      },
      setSubInput(config) {
        subInputs.push(config);
      },
    },
  };
  vm.runInNewContext(preloadSource, sandbox, {
    filename: "json-viewer/preload.js",
  });
  return { handlers, outputs, subInputs };
}

const [manifestSource, preloadSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src-tauri/resources/plugins/builtin/json-viewer/plugin.json", root), "utf8"),
  readFile(new URL("src-tauri/resources/plugins/builtin/json-viewer/preload.js", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const manifest = JSON.parse(manifestSource);
assert.equal(manifest.name, "json-viewer");
assert.deepEqual(manifest.features.map((feature) => feature.code), ["json"]);
assert.ok(manifest.features[0].cmds.includes("json"));
assert.ok(manifest.features[0].cmds.includes("json格式化"));
assert.ok(manifest.features[0].cmds.includes("格式化json"));

const plugin = loadJsonPlugin(preloadSource);
assert.equal(typeof plugin.handlers.enter, "function");
assert.equal(typeof plugin.handlers.subInput, "function");

plugin.handlers.enter({
  code: "json",
  type: "text",
  payload: '{"name":"ATools","items":[1,2]}',
});
assert.equal(plugin.outputs.length, 1);
assert.deepEqual(Array.from(plugin.outputs[0].items, (item) => item.title), [
  "格式化 JSON (对象，2 个键)",
  "压缩 JSON (minified)",
]);
assert.ok(plugin.outputs[0].items[0].data.includes('\n  "name": "ATools"'));
assert.ok(plugin.outputs[0].items[0].data.includes('\n  "items": ['));
assert.equal(plugin.outputs[0].items[1].data, '{"name":"ATools","items":[1,2]}');

const invalidPlugin = loadJsonPlugin(preloadSource);
invalidPlugin.handlers.enter({
  code: "json",
  type: "text",
  payload: "{bad json",
});
assert.equal(invalidPlugin.outputs.length, 1);
assert.equal(invalidPlugin.outputs[0].items[0].title, "JSON 格式错误");
assert.ok(invalidPlugin.outputs[0].items[0].description.length > 0);

const subInputPlugin = loadJsonPlugin(preloadSource);
subInputPlugin.handlers.enter({
  code: "json",
  type: "keyword",
  payload: "",
});
assert.deepEqual(normalize(subInputPlugin.subInputs), [
  {
    placeholder: "粘贴 JSON 字符串进行格式化",
    focus: true,
  },
]);
assert.equal(subInputPlugin.outputs.length, 0);

subInputPlugin.handlers.subInput({ text: '[{"ok":true}]' });
assert.equal(subInputPlugin.outputs.length, 1);
assert.equal(subInputPlugin.outputs[0].items[0].title, "格式化 JSON (数组，1 项)");
assert.equal(subInputPlugin.outputs[0].items[1].data, '[{"ok":true}]');

subInputPlugin.handlers.subInput({ text: "   " });
assert.deepEqual(normalize(subInputPlugin.outputs.at(-1)), { items: [] });

assert.ok(
  smokeChecklist.includes("- [x] 搜索 `JSON`，JSON 插件能显示格式化结果或错误。"),
  "macOS smoke checklist should mark builtin JSON plugin formatting/error flow complete",
);
