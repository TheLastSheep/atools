import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const normalize = (value) => JSON.parse(JSON.stringify(value));

function loadColorPlugin(preloadSource) {
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
    filename: "color-picker/preload.js",
  });
  return { handlers, outputs, subInputs };
}

const [manifestSource, preloadSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src-tauri/resources/plugins/builtin/color-picker/plugin.json", root), "utf8"),
  readFile(new URL("src-tauri/resources/plugins/builtin/color-picker/preload.js", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const manifest = JSON.parse(manifestSource);
assert.equal(manifest.name, "color-picker");
assert.deepEqual(manifest.features.map((feature) => feature.code), ["color"]);
assert.ok(manifest.features[0].cmds.includes("颜色"));
assert.ok(manifest.features[0].cmds.includes("color"));
assert.ok(manifest.features[0].cmds.includes("颜色转换"));
const hexCommand = manifest.features[0].cmds.find(
  (cmd) => typeof cmd === "object" && cmd?.type === "regex" && cmd.label === "颜色值",
);
assert.ok(hexCommand, "color plugin should expose a HEX regex command");
const hexPattern = new RegExp(hexCommand.match);
assert.equal(hexPattern.test("#fff"), true);
assert.equal(hexPattern.test("#ff0000"), true);
assert.equal(hexPattern.test("#ff00"), false);

const plugin = loadColorPlugin(preloadSource);
assert.equal(typeof plugin.handlers.enter, "function");
assert.equal(typeof plugin.handlers.subInput, "function");

plugin.handlers.enter({
  code: "color",
  type: "regex",
  payload: "#ff0000",
});
assert.equal(plugin.outputs.length, 1);
assert.deepEqual(Array.from(plugin.outputs[0].items, (item) => [item.title, item.data]), [
  ["HEX: #ff0000", "#ff0000"],
  ["RGB: rgb(255, 0, 0)", "rgb(255, 0, 0)"],
  ["HSL: hsl(0, 100%, 50%)", "hsl(0, 100%, 50%)"],
]);

const subInputPlugin = loadColorPlugin(preloadSource);
subInputPlugin.handlers.enter({
  code: "color",
  type: "keyword",
  payload: "",
});
assert.deepEqual(normalize(subInputPlugin.subInputs), [
  {
    placeholder: "输入颜色值 (#fff, #ffffff, rgb(255,255,255), hsl(0,100%,50%))",
    focus: true,
  },
]);
assert.equal(subInputPlugin.outputs.length, 0);

subInputPlugin.handlers.subInput({ text: "rgb(0, 128, 255)" });
assert.equal(subInputPlugin.outputs.length, 1);
assert.deepEqual(Array.from(subInputPlugin.outputs[0].items, (item) => [item.title, item.data]), [
  ["HEX: #0080ff", "#0080ff"],
  ["RGB: rgb(0, 128, 255)", "rgb(0, 128, 255)"],
  ["HSL: hsl(210, 100%, 50%)", "hsl(210, 100%, 50%)"],
]);

subInputPlugin.handlers.subInput({ text: "not-a-color" });
assert.equal(subInputPlugin.outputs.at(-1).items[0].title, "无法识别的颜色格式");
assert.equal(subInputPlugin.outputs.at(-1).items[0].description, "not-a-color");

subInputPlugin.handlers.subInput({ text: "   " });
assert.deepEqual(normalize(subInputPlugin.outputs.at(-1)), { items: [] });

assert.ok(
  smokeChecklist.includes("- [x] 搜索 `颜色`，颜色插件能输出转换结果。"),
  "macOS smoke checklist should mark builtin color plugin conversion flow complete",
);
