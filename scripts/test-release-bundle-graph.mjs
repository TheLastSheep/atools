import assert from "node:assert/strict";
import { test } from "node:test";
import { initialJavaScriptGraph, lazyJavaScriptGraph, summarizeLazyJavaScriptGraph } from "./lib/release-bundle-budget.mjs";

test("counts transitive shared chunks once and follows cycles without looping", () => {
  const manifest = {
    entry: { file: "assets/index-a.js", imports: ["shared", "other"] },
    shared: { file: "assets/shared-a.js", imports: ["other"] },
    other: { file: "assets/other-a.js", imports: ["shared"] },
  };
  assert.deepEqual(initialJavaScriptGraph(manifest, ["assets/index-a.js", "assets/shared-a.js"]),
    ["assets/index-a.js", "assets/other-a.js", "assets/shared-a.js"]);
});

test("rejects a lazy chunk pulled in by a transitive static import even without HTML preload", () => {
  const manifest = {
    entry: { file: "assets/index-a.js", imports: ["shared"] },
    shared: { file: "assets/shared-a.js", imports: ["panel"] },
    panel: { file: "assets/plugin-panel-a.js" },
  };
  assert.throws(() => initialJavaScriptGraph(manifest, ["assets/index-a.js"]), /index-a.*shared-a.*plugin-panel-a/);
});

test("keeps dynamic plugin and pinyin dependencies outside the initial graph", () => {
  const manifest = {
    entry: { file: "assets/index-a.js", dynamicImports: ["panel", "pinyin"] },
    panel: { file: "assets/plugin-panel-a.js" }, pinyin: { file: "assets/pinyin-engine-a.js" },
  };
  assert.deepEqual(initialJavaScriptGraph(manifest, ["assets/index-a.js"]), ["assets/index-a.js"]);
  assert.throws(() => initialJavaScriptGraph(manifest, ["assets/index-a.js", "assets/pinyin-engine-a.js"]), /Lazy chunk/);
});

test("rejects missing references and paths outside generated assets", () => {
  assert.throws(() => initialJavaScriptGraph({ entry: { file: "assets/index-a.js", imports: ["missing"] } }, ["assets/index-a.js"]), /Missing/);
  assert.throws(() => initialJavaScriptGraph({ entry: { file: "../outside.js" } }, ["../outside.js"]), /Invalid/);
});

test("reports a deduplicated static lazy closure and its initial-graph overlap", () => {
  const manifest = {
    index: { file: "assets/index.js", imports: ["shared", "initial-only"] },
    shared: { file: "assets/shared.js", imports: ["panel", "cycle-a"] },
    "initial-only": { file: "assets/initial.js" },
    panel: { file: "assets/plugin-panel.js", imports: ["shared", "feature-alias", "feature"],
      dynamicImports: ["deferred"], css: ["assets/panel.css"] },
    "feature-alias": { file: "assets/feature.js", imports: ["cycle-a"] },
    feature: { file: "assets/feature.js" },
    "cycle-a": { file: "assets/cycle-a.js", imports: ["cycle-b"] },
    "cycle-b": { file: "assets/cycle-b.js", imports: ["cycle-a"] },
    deferred: { file: "assets/deferred.js" },
  };
  const files = lazyJavaScriptGraph(manifest, "panel");
  assert.deepEqual(files, ["assets/cycle-a.js", "assets/cycle-b.js", "assets/feature.js",
    "assets/plugin-panel.js", "assets/shared.js"]);
  const summary = summarizeLazyJavaScriptGraph(files,
    ["assets/index.js", "assets/shared.js", "assets/cycle-a.js"], {
      "assets/cycle-a.js": 10, "assets/cycle-b.js": 20, "assets/feature.js": 30,
      "assets/plugin-panel.js": 40, "assets/shared.js": 50,
    });
  assert.equal(summary.metric, "static_closure");
  assert.equal(summary.unit, "uncompressed_emitted_js_bytes");
  assert.equal(summary.totalBytes, 150);
  assert.deepEqual(summary.sharedWithInitial, {
    assets: [{ file: "assets/cycle-a.js", bytes: 10 }, { file: "assets/shared.js", bytes: 50 }], bytes: 60,
  });
  assert.equal(summary.exclusiveToLazy.bytes, 90);
  assert.ok(!files.includes("assets/deferred.js"));
});

test("reports the full lazy closure as exclusive when it shares no initial asset", () => {
  const files = lazyJavaScriptGraph({ panel: { file: "assets/plugin-panel.js", imports: ["child"] },
    child: { file: "assets/panel-child.js" } }, "panel");
  const summary = summarizeLazyJavaScriptGraph(files, ["assets/index.js"], {
    "assets/plugin-panel.js": 11, "assets/panel-child.js": 13,
  });
  assert.equal(summary.sharedWithInitial.bytes, 0);
  assert.equal(summary.exclusiveToLazy.bytes, 24);
});

test("fails closed on missing lazy entries, unsafe asset paths, or incomplete size maps", () => {
  assert.throws(() => lazyJavaScriptGraph({ panel: { file: "assets/plugin-panel.js", imports: ["missing"] } }, "panel"), /Missing/);
  assert.throws(() => lazyJavaScriptGraph({ panel: { file: "assets/plugin-panel.js", imports: ["escape"] },
    escape: { file: "../outside.js" } }, "panel"), /Invalid JavaScript asset/);
  assert.throws(() => summarizeLazyJavaScriptGraph(["assets/plugin-panel.js"], [], {}), /Missing emitted JavaScript size/);
});
