import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("local-package UI selectors and business entry points remain anchored to original source", async () => {
  const [cron, content, calculation, codecHtml, codecApp] = await Promise.all([
    read("ZTools-plugins/plugins/cron/index.html"),
    read("ZTools-plugins/plugins/content-workbench/index.html"),
    read("ZTools-plugins/plugins/calculation-paper/index.js"),
    read("ZTools-plugins/plugins/developer-codec-tools/index.html"),
    read("ZTools-plugins/plugins/developer-codec-tools/app.js")
  ]);
  for (const id of ["cronVersion", "cronResult", "versionInfo", "min_start", "min_start_val", "min_start_step"])
    assert.match(cron, new RegExp(`id="${id}"`));
  for (const id of ["input", "output", "normalize", "plain", "links", "social"])
    assert.match(content, new RegExp(`id="${id}"`));
  assert.match(calculation, /className:"calc"/);
  assert.match(calculation, /placeholder:"计算公式"/);
  assert.match(calculation, /this\.props\.onChange\(t\)/);
  assert.match(calculation, /expression:"",result:""/);
  for (const id of ["operation", "inputText", "outputText", "runOperation", "statusLine"])
    assert.match(codecHtml, new RegExp(`id="${id}"`));
  assert.match(codecHtml, /data-category="text"/);
  assert.match(codecApp, /id: 'text',[\s\S]{0,100}op\('json-format'/);
  assert.match(codecApp, /activeCategory = button\.dataset\.category[\s\S]{0,80}renderOperations\(activeCategory\)/);
  assert.match(codecApp, /els\.operation\.innerHTML = ''[\s\S]{0,300}els\.operation\.append\(option\)/);
});

test("codec adapter changes to original text category before choosing JSON operations", async () => {
  const source = await read("tests/components/nativeOriginalCodecFrameOperations.js");
  const active = { category: "encoding", value: "base64-encode", options: ["base64-encode", "url-encode"] };
  const events = [];
  class Node {
    constructor(id, data = {}) { this.id = id; this.dataset = data; this.options = []; this._value = ""; this.textContent = ""; this.classList = { contains: token => token === "active" && this.dataset.category === active.category }; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    click() {
      events.push(`click:${this.id}`);
      if (this.dataset.category) {
        active.category = this.dataset.category;
        active.options = active.category === "text" ? ["json-format", "json-minify"] : ["base64-encode", "url-encode"];
        nodes.get("#operation").options = active.options.map(value => ({ value }));
        nodes.get("#operation")._value = active.options[0];
      }
    }
    dispatchEvent(event) { events.push(`event:${this.id}:${event.type}`); }
  }
  const nodes = new Map();
  for (const selector of ["#inputText", "#outputText", "#operation", "#runOperation", "#statusLine"])
    nodes.set(selector, new Node(selector));
  nodes.get("#operation").options = active.options.map(value => ({ value }));
  nodes.get("#operation")._value = active.value;
  const categories = ["encoding", "text"].map(value => new Node(`category:${value}`, { category: value }));
  const document = { querySelector(selector) {
    if (selector === ".category-item.active") return categories.find(node => node.dataset.category === active.category) || null;
    const category = selector.match(/^\.category-item\[data-category="(.*)"\]$/);
    if (category) return categories.find(node => node.dataset.category === category[1]) || null;
    return nodes.get(selector) || null;
  } };
  class HtmlSelectElement { }
  Object.defineProperty(HtmlSelectElement.prototype, "value", { get() { return this._value; }, set(value) { this._value = value; } });
  class HtmlTextAreaElement { }
  Object.defineProperty(HtmlTextAreaElement.prototype, "value", { get() { return this._value; }, set(value) { this._value = value; } });
  const window = {};
  vm.runInNewContext(source, { document, window, HTMLSelectElement: HtmlSelectElement, HTMLTextAreaElement: HtmlTextAreaElement,
    Event: class { constructor(type) { this.type = type; } }, Array, Object, String, Error });
  const adapter = window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  assert.equal(adapter.caseId, "local-developer-codec-tools");
  const state = adapter.perform("json-invalid");
  assert.equal(active.category, "text");
  assert.equal(state.category, "text");
  assert.equal(state.operation, "json-format");
  assert.equal(nodes.get("#inputText").value, "{bad json}");
  assert.deepEqual(events.slice(0, 4), ["click:category:text", "event:#inputText:input", "event:#operation:change", "click:#runOperation"]);
  assert.equal(events.some(event => /copy|paste/i.test(event)), false);
});
