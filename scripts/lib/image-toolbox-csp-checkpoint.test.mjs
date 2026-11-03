import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { imageToolboxCspCaptureScript, insertImageToolboxCspCapture } from "./image-toolbox-csp-checkpoint.mjs";

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'";
const MODULE = '<script type="module" src="index.js"></script>';
const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

test("inserts only after the exact CSP meta and before the unchanged original module entry", () => {
  const source = `<!doctype html><html><head>${META}<link rel="stylesheet" href="style.css"></head><body>${MODULE}</body></html>`;
  const result = insertImageToolboxCspCapture(source, CSP);
  const inserted = imageToolboxCspCaptureScript();
  assert.equal(result.split(META).length, 2);
  assert.equal(result.split(MODULE).length, 2);
  assert.ok(result.indexOf(META) + META.length < result.indexOf(inserted));
  assert.ok(result.indexOf(inserted) < result.indexOf(MODULE));
  assert.ok(result.startsWith(source.slice(0, source.indexOf(META) + META.length)));
  assert.ok(result.endsWith(source.slice(source.indexOf(META) + META.length)));
});

test("rejects missing or duplicated CSP and missing/reordered module entry", () => {
  assert.throws(() => insertImageToolboxCspCapture(`<html><head>${MODULE}</head></html>`, CSP));
  assert.throws(() => insertImageToolboxCspCapture(`<html><head>${META}${META}${MODULE}</head></html>`, CSP));
  assert.throws(() => insertImageToolboxCspCapture(`<html><head>${META}</head><body></body></html>`, CSP));
  assert.throws(() => insertImageToolboxCspCapture(`<html><head>${MODULE}${META}</head></html>`, CSP));
});

function runCapture(blockedUri, effectiveDirective) {
  const listeners = new Map();
  const messages = [];
  const window = {
    parent: { postMessage: message => messages.push(message) },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  vm.runInNewContext(imageToolboxCspCaptureScript().replace(/^<script>|<\/script>$/g, ""), { window, URL });
  const listener = listeners.get("securitypolicyviolation");
  assert.equal(typeof listener, "function");
  listener({ blockedURI: blockedUri, effectiveDirective });
  listener({ blockedURI: blockedUri, effectiveDirective });
  return { messages, listenerRemaining: listeners.has("securitypolicyviolation") };
}

test("emits only fixed allowlisted checkpoints for leased script scheme and exact alias host", () => {
  for (const [blockedUri, directive] of [
    ["atools-plugin://localhost/lease/index.js", "script-src-elem"],
    ["https://atools-plugin.localhost/lease/index.js", "script-src"],
  ]) {
    const { messages, listenerRemaining } = runCapture(blockedUri, directive);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
      { kind: "atools-image-toolbox-child-checkpoint", code: "child-csp-observer-installed", observed: true },
      { kind: "atools-image-toolbox-child-checkpoint", code: "child-module-lease-script-csp-blocked", observed: true },
    ]);
    assert.equal(listenerRemaining, false);
    assert.equal(JSON.stringify(messages).includes("lease/index.js"), false);
    assert.equal(JSON.stringify(messages).includes("blockedURI"), false);
  }
});

test("does not report non-script directives or other origins", () => {
  for (const [blockedUri, directive] of [
    ["atools-plugin://localhost/lease/index.js", "img-src"],
    ["https://attacker.atools-plugin.localhost/lease/index.js", "script-src-elem"],
    ["https://atools-plugin.localhost.attacker.invalid/index.js", "script-src"],
    ["atools-plugin://attacker/lease/index.js", "script-src"],
    ["atools-plugin://localhost.attacker.invalid/lease/index.js", "script-src"],
    ["atools-plugin:/lease/index.js", "script-src"],
    ["atools-plugin:localhost/lease/index.js", "script-src"],
    ["atools-custom://localhost/lease/index.js", "script-src"],
    ["https://user@atools-plugin.localhost/lease/index.js", "script-src"],
    ["https://atools-plugin.localhost:443/lease/index.js", "script-src"],
    ["https://atools-plugin.localhost:444/lease/index.js", "script-src"],
    ["atools-plugin://user@localhost/lease/index.js", "script-src"],
    ["atools-plugin://localhost:123/lease/index.js", "script-src"],
    ["https://example.invalid/index.js", "script-src"],
  ]) {
    const { messages, listenerRemaining } = runCapture(blockedUri, directive);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
      { kind: "atools-image-toolbox-child-checkpoint", code: "child-csp-observer-installed", observed: true },
    ]);
    assert.equal(listenerRemaining, true);
  }
});


test("caps unrelated CSP event work and removes the listener at the limit", () => {
  const listeners = new Map();
  const messages = [];
  const window = {
    parent: { postMessage: message => messages.push(message) },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  vm.runInNewContext(imageToolboxCspCaptureScript().replace(/^<script>|<\/script>$/g, ""), { window, URL });
  assert.equal(typeof listeners.get("securitypolicyviolation"), "function");
  const dispatch = event => listeners.get("securitypolicyviolation")?.(event);
  for (let index = 0; index < 32; index += 1) {
    dispatch({ blockedURI: "https://unrelated.invalid/resource", effectiveDirective: "img-src" });
  }
  assert.equal(listeners.has("securitypolicyviolation"), false);
  dispatch({ blockedURI: "atools-plugin://localhost/lease/index.js", effectiveDirective: "script-src-elem" });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { kind: "atools-image-toolbox-child-checkpoint", code: "child-csp-observer-installed", observed: true },
  ]);
});
