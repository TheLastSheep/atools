import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(await readFile(path.join(root, "tests/fixtures/local-original-plugin-cases.json"), "utf8"));
const profile = registry.cases.find(item => item.caseId === "local-calculation-paper-head");
assert.ok(profile, "HEAD calculation case must be registered");
assert.equal(profile.frameOperations, "tests/components/nativeOriginalCalculationHeadFrameOperations.js");
const frameSource = await readFile(path.join(root, profile.frameOperations), "utf8");
const values = new WeakMap(), fields = [];
class HTMLTextAreaElement {}
Object.defineProperty(HTMLTextAreaElement.prototype, "value", { get() { return values.get(this) || ""; }, set(value) { values.set(this, value); } });
class FakeArea extends HTMLTextAreaElement {
  constructor(value = "") { super(); values.set(this, value); this.inputs = 0; }
  closest() { return { querySelector: () => ({ textContent: "" }) }; }
  dispatchEvent(event) {
    assert.equal(event.type, "input"); assert.equal(event.bubbles, true); this.inputs += 1;
    if (this.value && fields.at(-1) === this) fields.push(new FakeArea());
    return true;
  }
}
fields.push(new FakeArea());
const context = { window: {}, document: { querySelector: selector => selector === "#root" ? {} : null,
  querySelectorAll: selector => selector === '.calc textarea[placeholder="计算公式"]' ? fields : [] },
  HTMLTextAreaElement, Event: class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }, Array, Error };
vm.runInNewContext(frameSource, context);
const operations = context.window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
assert.equal(operations.caseId, "local-calculation-paper-head");
assert.equal(operations.perform("set-tail-expression", { value: "6*7" }).rows[0].expression, "6*7");
assert.equal(operations.state().trailingBlank, true);
assert.equal(operations.perform("clear-tail-expression", {}).rows.some(row => row.expression === "6*7"), false);
assert.equal(operations.perform("set-tail-expression", { value: "8*9" }).rows.some(row => row.expression === "8*9"), true);
assert.equal(fields.reduce((sum, field) => sum + field.inputs, 0), 3);
assert.throws(() => operations.perform("set-tail-expression", { value: "process.exit()" }), /Unapproved Calculation Paper expression/);
assert.throws(() => operations.perform("clear-tail-expression", { value: "6*7" }), /no expression payload/);
assert.throws(() => operations.perform("copy-result"), /Unknown original Calculation Paper operation/);
console.log("HEAD Calculation Paper frame-operation contract: PASS (DOM bridge only; no engine/runtime claim)");
