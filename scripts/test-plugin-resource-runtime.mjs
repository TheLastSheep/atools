import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { assertCheckedChecklistRow } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const resourceChecklistRow = "插件 HTML 资源兼容由 `pnpm test:plugin-resource-html` 覆盖：`main_url` 子目录、相对 script/style、CSS `url(...)` / `@import`、`srcset`、link icon/modulepreload、常见图片/媒体资源，以及入口 HTML 本地 `<base href>` 下的静态资源会按入口文件目录或声明 base 目录解析，改写后的 `<base>` 会保留原始本地 href marker；运行时动态资源属性解析由 `pnpm test:plugin-resource-runtime` 覆盖，常见动态插入的 image/media/script/link/object 节点、`<style>` 文本、inline `style` 属性、`CSSStyleSheet.insertRule()` 规则，以及 fetch-sensitive 的动态 script/link 通过 `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` 插入前 preflight 会经父窗口转换本地相对 URL，并在存在当前本地 `<base href>` marker 或插件运行时更新后的 live 本地 `<base href>` 时按声明 base 目录解析。";

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");
assert.match(componentSource, /once: function\(event, listener\)/, "PluginPanel should expose process.once for CommonJS preload compatibility");
assert.match(componentSource, /nextTick: function\(callback\)/, "PluginPanel should expose process.nextTick for CommonJS preload compatibility");
assert.match(componentSource, /window\.global = window/, "PluginPanel should expose the CommonJS global alias");
assert.match(componentSource, /window\.__atoolsNativeWorker/, "PluginPanel should preserve the native Worker constructor");
assert.match(componentSource, /importScripts\(/, "PluginPanel should bootstrap local classic workers inside the opaque sandbox");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("runtime-resource-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("runtime-resource-test-feature"))
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const postedMessages = [];
const mutationObservers = [];

class ElementStub {
  constructor(tagName, attrs = {}, textContent = "") {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.textContent = textContent;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...items) {
    this.children.push(...items);
    items.forEach((item) => {
      if (item && typeof item === "object") item.parentNode = this;
    });
  }

  prepend(...items) {
    this.children.unshift(...items);
    items.forEach((item) => {
      if (item && typeof item === "object") item.parentNode = this;
    });
  }

  insertBefore(child, before) {
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) {
      this.children.splice(index, 0, child);
    } else {
      this.children.push(child);
    }
    child.parentNode = this;
    return child;
  }

  before(...items) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index < 0) return;
    this.parentNode.children.splice(index, 0, ...items);
    items.forEach((item) => {
      if (item && typeof item === "object") item.parentNode = this.parentNode;
    });
  }

  after(...items) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index < 0) return;
    this.parentNode.children.splice(index + 1, 0, ...items);
    items.forEach((item) => {
      if (item && typeof item === "object") item.parentNode = this.parentNode;
    });
  }

  replaceWith(...items) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    parent.children.splice(index, 1, ...items);
    this.parentNode = undefined;
    items.forEach((item) => {
      if (item && typeof item === "object") item.parentNode = parent;
    });
  }

  querySelectorAll() {
    return this.children;
  }
}

const initialImage = new ElementStub("img", { src: "./dynamic/logo.png" });
const initialSource = new ElementStub("source", {
  srcset: "./small.png 1x, data:image/png;base64,abc 2x",
});
const initialStyle = new ElementStub(
  "style",
  {},
  '@import "./theme/base.css"; .hero { background: url("../assets/bg image.png?size=2"); } .remote { background: url("https://example.com/bg.png"); }',
);
const initialStyledDiv = new ElementStub("div", {
  style: "background-image: url('../inline/bg.png'); mask: url(data:image/png;base64,abc)",
});
const baseElement = new ElementStub("base", {
  href: "asset(/plugins/sample/pages/runtime/)",
  "data-atools-plugin-base-href": "./runtime/",
});

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
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

const documentStub = {
  readyState: "complete",
  documentElement: { nodeType: 1 },
  body: { nodeType: 1 },
  addEventListener(type, cb) {
    const list = listeners.get(`document:${type}`) || [];
    list.push(cb);
    listeners.set(`document:${type}`, list);
  },
  querySelector(selector) {
    if (selector === "base[href]") {
      return baseElement;
    }
    return null;
  },
  querySelectorAll(selector) {
    assert.match(selector, /\[src\]/, "runtime resource scanner should look for src-bearing nodes");
    assert.match(selector, /style/, "runtime resource scanner should include style elements and style attributes");
    return [initialImage, initialSource, initialStyle, initialStyledDiv];
  },
};

class EventStub {
  constructor(type) {
    this.type = type;
  }
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
    mutationObservers.push(this);
  }

  observe(target, options) {
    if (target === documentStub.documentElement) {
      throw new TypeError("parameter 1 is not of type 'Node'");
    }
    this.target = target;
    this.options = options;
  }
}

class CSSStyleSheetStub {
  constructor() {
    this.cssRules = [];
  }

  insertRule(rule, index = this.cssRules.length) {
    this.cssRules.splice(index, 0, { cssText: String(rule) });
    return index;
  }

  deleteRule(index) {
    this.cssRules.splice(index, 1);
  }
}

windowStub.CSSStyleSheet = CSSStyleSheetStub;
windowStub.Node = ElementStub;
windowStub.Element = ElementStub;

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
  Event: EventStub,
  MutationObserver: MutationObserverStub,
  CSSStyleSheet: CSSStyleSheetStub,
  Node: ElementStub,
  Element: ElementStub,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  Date,
  Math,
  Number,
  Promise,
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

function resourceMessages() {
  return postedMessages.filter((message) => message.__atools_resource_resolve__);
}

function respondToResourceCall(call, payload) {
  const handlers = listeners.get("message") || [];
  handlers.forEach((handler) => handler({
    data: {
      __atools_resource_response__: true,
      reqId: call.reqId,
      ...payload,
    },
  }));
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

assert.equal(
  typeof windowStub.__atools_resolve_plugin_resource__,
  "function",
  "bridge should expose an async runtime resource resolver",
);
assert.equal(mutationObservers.length, 1, "bridge should observe DOM changes for dynamic resources");
assert.equal(mutationObservers[0].target, documentStub.body, "runtime resource observer should fall back to body when documentElement cannot be observed");
assert.equal(mutationObservers[0].options.subtree, true, "runtime resource observer should watch descendant nodes");
assert.ok(mutationObservers[0].options.attributeFilter.includes("srcset"), "runtime observer should watch srcset changes");
assert.ok(mutationObservers[0].options.attributeFilter.includes("style"), "runtime observer should watch style attribute changes");
assert.equal(mutationObservers[0].options.characterData, true, "runtime observer should watch style text changes");

const directPromise = windowStub.__atools_resolve_plugin_resource__("../assets/icon.svg");
const directCall = resourceMessages().find((message) => message.url === "../assets/icon.svg");
assert.ok(directCall, "direct runtime resource resolver should ask the parent to convert local URLs");
respondToResourceCall(directCall, { url: "asset(/plugins/sample/assets/icon.svg)" });
assert.equal(await directPromise, "asset(/plugins/sample/assets/icon.svg)");

const imageCall = resourceMessages().find((message) => message.url === "./dynamic/logo.png");
assert.ok(imageCall, "initial image src should be resolved through the parent");
assert.equal(imageCall.baseDir, "./runtime/", "runtime image resources should include the current local base href");
respondToResourceCall(imageCall, { url: "asset(/plugins/sample/pages/runtime/dynamic/logo.png)" });
await flushPromises();
assert.equal(initialImage.getAttribute("src"), "asset(/plugins/sample/pages/runtime/dynamic/logo.png)");
assert.equal(
  initialImage.getAttribute("data-atools-resource-resolved-src"),
  "asset(/plugins/sample/pages/runtime/dynamic/logo.png)",
);

const srcsetCall = resourceMessages().find((message) => message.url === "./small.png");
assert.ok(srcsetCall, "initial source srcset should resolve local candidates");
assert.equal(srcsetCall.baseDir, "./runtime/", "runtime srcset resources should include the current local base href");
respondToResourceCall(srcsetCall, { url: "asset(/plugins/sample/pages/runtime/small.png)" });
await flushPromises();
assert.equal(
  initialSource.getAttribute("srcset"),
  "asset(/plugins/sample/pages/runtime/small.png) 1x, data:image/png;base64,abc 2x",
);

baseElement.setAttribute("href", "./live/");
const liveBasePromise = windowStub.__atools_resolve_plugin_resource__("./dynamic/live-logo.png");
const liveBaseCall = resourceMessages().find((message) => message.url === "./dynamic/live-logo.png");
assert.ok(liveBaseCall, "runtime resolver should use the current base href for later resource requests");
assert.equal(
  liveBaseCall.baseDir,
  "./live/",
  "runtime resolver should prefer a live local base href over the stale static base marker",
);
respondToResourceCall(liveBaseCall, { url: "asset(/plugins/sample/pages/live/dynamic/live-logo.png)" });
assert.equal(await liveBasePromise, "asset(/plugins/sample/pages/live/dynamic/live-logo.png)");
baseElement.setAttribute("href", "asset(/plugins/sample/pages/runtime/)");

const cssImportCall = resourceMessages().find((message) => message.url === "./theme/base.css");
assert.ok(cssImportCall, "initial style @import should resolve local stylesheet URLs");
assert.equal(cssImportCall.baseDir, "./runtime/", "runtime CSS @import resources should include the current local base href");
respondToResourceCall(cssImportCall, { url: "asset(/plugins/sample/pages/runtime/theme/base.css)" });
const cssBackgroundCall = resourceMessages().find((message) => message.url === "../assets/bg image.png?size=2");
assert.ok(cssBackgroundCall, "initial style url(...) should resolve local asset URLs");
assert.equal(cssBackgroundCall.baseDir, "./runtime/", "runtime CSS url(...) resources should include the current local base href");
respondToResourceCall(cssBackgroundCall, { url: "asset(/plugins/sample/assets/bg image.png)?size=2" });
await flushPromises();
assert.equal(
  initialStyle.textContent,
  '@import "asset(/plugins/sample/pages/runtime/theme/base.css)"; .hero { background: url("asset(/plugins/sample/assets/bg image.png)?size=2"); } .remote { background: url("https://example.com/bg.png"); }',
);
assert.equal(
  resourceMessages().some((message) => String(message.url).startsWith("https://")),
  false,
  "runtime CSS resolver should leave remote URLs untouched",
);

const inlineStyleCall = resourceMessages().find((message) => message.url === "../inline/bg.png");
assert.ok(inlineStyleCall, "inline style attributes should resolve local url(...) values");
assert.equal(inlineStyleCall.baseDir, "./runtime/", "runtime inline style resources should include the current local base href");
respondToResourceCall(inlineStyleCall, { url: "asset(/plugins/sample/pages/inline/bg.png)" });
await flushPromises();
assert.equal(
  initialStyledDiv.getAttribute("style"),
  'background-image: url("asset(/plugins/sample/pages/inline/bg.png)"); mask: url(data:image/png;base64,abc)',
);

const insertedVideo = new ElementStub("video", { poster: "../poster.png" });
mutationObservers[0].callback([{ addedNodes: [insertedVideo], type: "childList" }]);
const posterCall = resourceMessages().find((message) => message.url === "../poster.png");
assert.ok(posterCall, "newly inserted media poster should be resolved through the observer");
assert.equal(posterCall.baseDir, "./runtime/", "runtime poster resources should include the current local base href");
respondToResourceCall(posterCall, { url: "asset(/plugins/sample/pages/poster.png)" });
await flushPromises();
assert.equal(insertedVideo.getAttribute("poster"), "asset(/plugins/sample/pages/poster.png)");

const insertedStyle = new ElementStub("style", {}, ".icon { background: url('./icons/add.svg'); }");
mutationObservers[0].callback([{ addedNodes: [insertedStyle], type: "childList" }]);
const insertedStyleCall = resourceMessages().find((message) => message.url === "./icons/add.svg");
assert.ok(insertedStyleCall, "newly inserted style elements should resolve local CSS URLs");
assert.equal(insertedStyleCall.baseDir, "./runtime/", "runtime inserted style resources should include the current local base href");
respondToResourceCall(insertedStyleCall, { url: "asset(/plugins/sample/pages/runtime/icons/add.svg)" });
await flushPromises();
assert.equal(insertedStyle.textContent, '.icon { background: url("asset(/plugins/sample/pages/runtime/icons/add.svg)"); }');

initialStyledDiv.setAttribute("style", "background: url('./hover.png')");
mutationObservers[0].callback([{ target: initialStyledDiv, type: "attributes", attributeName: "style" }]);
const updatedInlineStyleCall = resourceMessages().find((message) => message.url === "./hover.png");
assert.ok(updatedInlineStyleCall, "style attribute mutations should resolve new local CSS URLs");
assert.equal(updatedInlineStyleCall.baseDir, "./runtime/", "runtime style mutations should include the current local base href");
respondToResourceCall(updatedInlineStyleCall, { url: "asset(/plugins/sample/pages/runtime/hover.png)" });
await flushPromises();
assert.equal(initialStyledDiv.getAttribute("style"), 'background: url("asset(/plugins/sample/pages/runtime/hover.png)")');

const dynamicSheet = new CSSStyleSheetStub();
const insertedRuleIndex = dynamicSheet.insertRule(".sheet-icon { background: url('./sheet/icon.svg'); }", 0);
assert.equal(insertedRuleIndex, 0, "patched CSSStyleSheet.insertRule should preserve the inserted index");
const insertRuleCall = resourceMessages().find((message) => message.url === "./sheet/icon.svg");
assert.ok(insertRuleCall, "CSSStyleSheet.insertRule should resolve local CSS url(...) values");
assert.equal(insertRuleCall.baseDir, "./runtime/", "runtime CSSStyleSheet resources should include the current local base href");
respondToResourceCall(insertRuleCall, { url: "asset(/plugins/sample/pages/runtime/sheet/icon.svg)" });
await flushPromises();
assert.equal(
  dynamicSheet.cssRules[0].cssText,
  '.sheet-icon { background: url("asset(/plugins/sample/pages/runtime/sheet/icon.svg)"); }',
);

const head = new ElementStub("head");
const dynamicScript = new ElementStub("script", { src: "./chunks/dynamic.js" });
assert.equal(head.appendChild(dynamicScript), dynamicScript, "patched appendChild should preserve return value");
assert.equal(head.children.length, 0, "local dynamic script should not be appended before resource resolution");
const dynamicScriptCall = resourceMessages().find((message) => message.url === "./chunks/dynamic.js");
assert.ok(dynamicScriptCall, "dynamic script append should resolve src before insertion");
assert.equal(dynamicScriptCall.baseDir, "./runtime/", "runtime script preflight should include the current local base href");
respondToResourceCall(dynamicScriptCall, { url: "asset(/plugins/sample/pages/runtime/chunks/dynamic.js)" });
await flushPromises();
assert.equal(dynamicScript.getAttribute("src"), "asset(/plugins/sample/pages/runtime/chunks/dynamic.js)");
assert.equal(head.children.length, 1, "dynamic script should be appended after resource resolution");
assert.equal(head.children[0], dynamicScript);

const dynamicLink = new ElementStub("link", { rel: "stylesheet", href: "./styles/dynamic.css" });
assert.equal(head.insertBefore(dynamicLink, dynamicScript), dynamicLink, "patched insertBefore should preserve return value");
assert.equal(head.children[0], dynamicScript, "local dynamic link should not be inserted before resource resolution");
const dynamicLinkCall = resourceMessages().find((message) => message.url === "./styles/dynamic.css");
assert.ok(dynamicLinkCall, "dynamic link insertBefore should resolve href before insertion");
assert.equal(dynamicLinkCall.baseDir, "./runtime/", "runtime link preflight should include the current local base href");
respondToResourceCall(dynamicLinkCall, { url: "asset(/plugins/sample/pages/runtime/styles/dynamic.css)" });
await flushPromises();
assert.equal(dynamicLink.getAttribute("href"), "asset(/plugins/sample/pages/runtime/styles/dynamic.css)");
assert.equal(head.children[0], dynamicLink, "dynamic link should be inserted before the reference after resolution");
assert.equal(head.children[1], dynamicScript);

const appendScript = new ElementStub("script", { src: "./chunks/append.js" });
assert.equal(head.append(appendScript), undefined, "patched append should preserve undefined return value");
assert.equal(head.children.includes(appendScript), false, "local append script should not be inserted before resource resolution");
const appendScriptCall = resourceMessages().find((message) => message.url === "./chunks/append.js");
assert.ok(appendScriptCall, "append script should resolve src before variadic insertion");
assert.equal(appendScriptCall.baseDir, "./runtime/", "runtime append preflight should include the current local base href");
respondToResourceCall(appendScriptCall, { url: "asset(/plugins/sample/pages/runtime/chunks/append.js)" });
await flushPromises();
assert.equal(appendScript.getAttribute("src"), "asset(/plugins/sample/pages/runtime/chunks/append.js)");
assert.equal(head.children.at(-1), appendScript, "append script should be inserted after resource resolution");

const prependLink = new ElementStub("link", { rel: "stylesheet", href: "./styles/prepend.css" });
assert.equal(head.prepend(prependLink), undefined, "patched prepend should preserve undefined return value");
assert.notEqual(head.children[0], prependLink, "local prepend link should not be inserted before resource resolution");
const prependLinkCall = resourceMessages().find((message) => message.url === "./styles/prepend.css");
assert.ok(prependLinkCall, "prepend link should resolve href before variadic insertion");
assert.equal(prependLinkCall.baseDir, "./runtime/", "runtime prepend preflight should include the current local base href");
respondToResourceCall(prependLinkCall, { url: "asset(/plugins/sample/pages/runtime/styles/prepend.css)" });
await flushPromises();
assert.equal(prependLink.getAttribute("href"), "asset(/plugins/sample/pages/runtime/styles/prepend.css)");
assert.equal(head.children[0], prependLink, "prepend link should be inserted after resource resolution");

const beforeScript = new ElementStub("script", { src: "./chunks/before.js" });
assert.equal(dynamicScript.before(beforeScript), undefined, "patched before should preserve undefined return value");
assert.equal(head.children.includes(beforeScript), false, "local before script should not be inserted before resource resolution");
const beforeScriptCall = resourceMessages().find((message) => message.url === "./chunks/before.js");
assert.ok(beforeScriptCall, "before script should resolve src before sibling insertion");
assert.equal(beforeScriptCall.baseDir, "./runtime/", "runtime before preflight should include the current local base href");
respondToResourceCall(beforeScriptCall, { url: "asset(/plugins/sample/pages/runtime/chunks/before.js)" });
await flushPromises();
assert.equal(beforeScript.getAttribute("src"), "asset(/plugins/sample/pages/runtime/chunks/before.js)");
assert.equal(head.children[head.children.indexOf(dynamicScript) - 1], beforeScript, "before script should be inserted before the reference after resource resolution");

const afterLink = new ElementStub("link", { rel: "stylesheet", href: "./styles/after.css" });
assert.equal(dynamicLink.after(afterLink), undefined, "patched after should preserve undefined return value");
assert.equal(head.children.includes(afterLink), false, "local after link should not be inserted before resource resolution");
const afterLinkCall = resourceMessages().find((message) => message.url === "./styles/after.css");
assert.ok(afterLinkCall, "after link should resolve href before sibling insertion");
assert.equal(afterLinkCall.baseDir, "./runtime/", "runtime after preflight should include the current local base href");
respondToResourceCall(afterLinkCall, { url: "asset(/plugins/sample/pages/runtime/styles/after.css)" });
await flushPromises();
assert.equal(afterLink.getAttribute("href"), "asset(/plugins/sample/pages/runtime/styles/after.css)");
assert.equal(head.children[head.children.indexOf(dynamicLink) + 1], afterLink, "after link should be inserted after the reference after resource resolution");

const replaceTarget = new ElementStub("meta", { name: "replace-target" });
head.appendChild(replaceTarget);
const replacementScript = new ElementStub("script", { src: "./chunks/replacement.js" });
assert.equal(replaceTarget.replaceWith(replacementScript), undefined, "patched replaceWith should preserve undefined return value");
assert.equal(head.children.includes(replacementScript), false, "local replacement script should not be inserted before resource resolution");
assert.equal(head.children.includes(replaceTarget), true, "replace target should remain until replacement resource resolves");
const replacementScriptCall = resourceMessages().find((message) => message.url === "./chunks/replacement.js");
assert.ok(replacementScriptCall, "replaceWith script should resolve src before replacement insertion");
assert.equal(replacementScriptCall.baseDir, "./runtime/", "runtime replaceWith preflight should include the current local base href");
respondToResourceCall(replacementScriptCall, { url: "asset(/plugins/sample/pages/runtime/chunks/replacement.js)" });
await flushPromises();
assert.equal(replacementScript.getAttribute("src"), "asset(/plugins/sample/pages/runtime/chunks/replacement.js)");
assert.equal(head.children.includes(replaceTarget), false, "replace target should be removed after replacement resource resolution");
assert.equal(head.children.includes(replacementScript), true, "replacement script should be inserted after resource resolution");

assert.match(componentSource, /convertPluginResourceUrl/, "PluginPanel should import the runtime resource converter");
assert.match(componentSource, /__atools_resource_resolve__/, "parent message handler should accept runtime resource requests");
assert.match(componentSource, /__atools_resource_response__/, "parent message handler should return runtime resource responses");
assert.match(componentSource, /action\.main_url \|\| "index\.html"/, "runtime resource conversion should honor plugin main_url");
assert.match(componentSource, /characterData:\s*true/, "runtime observer should watch style text mutations");
assert.match(componentSource, /insertRule/, "runtime bridge should patch CSSStyleSheet.insertRule");
assert.match(componentSource, /appendChild/, "runtime bridge should preflight dynamic script/link appendChild insertion");
assert.match(componentSource, /insertBefore/, "runtime bridge should preflight dynamic script/link insertBefore insertion");
assert.match(componentSource, /replaceWith/, "runtime bridge should preflight dynamic script/link replaceWith insertion");

const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
assertCheckedChecklistRow(checklist, resourceChecklistRow);
