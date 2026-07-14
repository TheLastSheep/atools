import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEB_PREVIEW_PLUGIN_PATH = "__atools_plugin_host_preview__";
const ZTOOLS_DEFAULT_WINDOW_HEIGHT = 541;
const DEFAULT_SCREENSHOT_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 820 },
  { name: "compact", width: 390, height: 800 },
];
const DEFAULT_BRIDGE_PROBES = [
  { id: "plugin-enter-event", attribute: "data-atools-plugin-enter", expected: "true" },
  { id: "plugin-ready-event", attribute: "data-atools-plugin-ready", expected: "true" },
  { id: "utools-bridge-present", attribute: "data-utools-bridge-present", expected: "true" },
  { id: "ztools-alias-present", attribute: "data-ztools-alias-present", expected: "true" },
  { id: "iframe-dom-identity", attribute: "data-external-plugin-id", expected: "" },
];
const REAL_ENTRY_BRIDGE_API_PROBE_IDS = [
  "fixture-bridge-get-path",
  "fixture-bridge-context",
  "fixture-bridge-db-storage",
  "fixture-bridge-db-all-docs",
  "fixture-bridge-app-identity",
  "fixture-bridge-system-flags",
  "fixture-bridge-preload-ky",
  "fixture-bridge-services",
  "fixture-bridge-web-storage",
];
const RUNTIME_SUPPORT_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".wasm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot"]);

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pluginWindowHeight(value) {
  return Math.min(numberOrDefault(value, ZTOOLS_DEFAULT_WINDOW_HEIGHT), ZTOOLS_DEFAULT_WINDOW_HEIGHT);
}

function normalizedPermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringOrEmpty).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function htmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlText(value) {
  return String(value ?? "").replace(/<\/script/gi, "<\\/script");
}

function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function countMatches(value, pattern) {
  return [...String(value || "").matchAll(pattern)].length;
}

function attributeValue(attrs, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*([\"'])([^\"']*)\\1`, "i");
  const match = String(attrs || "").match(pattern);
  if (match) return match[2];
  const unquotedPattern = new RegExp(`\\s${name}\\s*=\\s*([^\\s>]+)`, "i");
  return String(attrs || "").match(unquotedPattern)?.[1] || "";
}

function isLocalResourceUrl(value) {
  const url = stringOrEmpty(value);
  if (!url || url.startsWith("#")) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return false;
  return true;
}

function resourcePathFromUrl(entryDirectory, url) {
  const value = stringOrEmpty(url);
  const cleanPath = value.split("#")[0].split("?")[0];
  if (!isLocalResourceUrl(cleanPath)) return null;
  return resolve(entryDirectory, cleanPath);
}

function extractEntryResourceReferences(html) {
  const scripts = [];
  const stylesheets = [];

  for (const match of String(html || "").matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1] || "";
    const src = attributeValue(attrs, "src");
    if (!isLocalResourceUrl(src)) continue;
    scripts.push({
      kind: "script",
      url: src,
      module: /\stype\s*=\s*(["'])?module\1?/i.test(attrs),
    });
  }

  for (const match of String(html || "").matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1] || "";
    const rel = attributeValue(attrs, "rel");
    const href = attributeValue(attrs, "href");
    if (!/\bstylesheet\b/i.test(rel) || !isLocalResourceUrl(href)) continue;
    stylesheets.push({
      kind: "stylesheet",
      url: href,
    });
  }

  return { scripts, stylesheets };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function slugPart(value) {
  return stringOrEmpty(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "sample";
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readManifest(sourcePath) {
  return readJson(join(sourcePath, "plugin.json"));
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function installedPluginPath(plan) {
  const installRoot = stringOrEmpty(plan?.install?.install_root) || "/tmp/atools-ztools-plugin-smoke";
  const pluginId = stringOrEmpty(plan?.install?.expected_plugin_id) || stringOrEmpty(plan?.expected_install_id) || stringOrEmpty(plan?.name);
  return join(installRoot, pluginId);
}

function installedPreloadPath(pluginPath, manifest) {
  const preload = stringOrEmpty(manifest?.preload);
  return preload ? join(pluginPath, preload) : null;
}

function pluginTitle(plan, manifest) {
  return stringOrEmpty(manifest?.title) || stringOrEmpty(plan?.title) || stringOrEmpty(manifest?.name) || stringOrEmpty(plan?.name);
}

function pluginId(plan, manifest) {
  return stringOrEmpty(plan?.install?.expected_plugin_id)
    || stringOrEmpty(plan?.expected_install_id)
    || stringOrEmpty(manifest?.name)
    || stringOrEmpty(plan?.name);
}

function featureCode(plan) {
  return stringOrEmpty(plan?.activation?.feature_code);
}

function resourceSignals(html) {
  return {
    script_src_count: countMatches(html, /<script\b(?=[^>]*\bsrc\s*=)[^>]*>/gi),
    module_script_count: countMatches(html, /<script\b(?=[^>]*\bsrc\s*=)(?=[^>]*\btype\s*=\s*["']?module\b)[^>]*>/gi),
    inline_script_count: countMatches(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi),
    stylesheet_link_count: countMatches(html, /<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)[^>]*>/gi),
    image_reference_count: countMatches(html, /<(?:img|source|video|audio)\b(?=[^>]*\bsrc\s*=)[^>]*>/gi),
    bridge_reference: /\b(?:utools|ztools)\b/.test(String(html || "")),
  };
}

async function realEntryHtmlReadiness(plan, manifest) {
  const mainUrl = stringOrEmpty(manifest?.main) || "index.html";
  const sourcePath = stringOrEmpty(plan?.source_path);
  if (!sourcePath) {
    return {
      expected: true,
      status: "missing-source-path",
      main_url: mainUrl,
      html_path: "",
      entry_directory: "",
      relative_entry_directory: "",
      bytes: 0,
      sha256: "",
      resource_signals: resourceSignals(""),
    };
  }

  const sourceRoot = resolve(sourcePath);
  const htmlPath = resolve(sourceRoot, mainUrl);
  const sourceRelativePath = relative(sourceRoot, htmlPath);
  const outsideSource = sourceRelativePath.startsWith("..") || isAbsolute(sourceRelativePath);
  const entryDirectory = outsideSource ? "" : dirname(htmlPath);
  const relativeEntryDirectory = entryDirectory
    ? relative(sourceRoot, entryDirectory) || "."
    : "";

  if (outsideSource) {
    return {
      expected: true,
      status: "outside-source",
      main_url: mainUrl,
      html_path: htmlPath,
      entry_directory: entryDirectory,
      relative_entry_directory: relativeEntryDirectory,
      bytes: 0,
      sha256: "",
      resource_signals: resourceSignals(""),
    };
  }

  try {
    const buffer = await readFile(htmlPath);
    const html = buffer.toString("utf8");
    return {
      expected: true,
      status: "ready",
      main_url: mainUrl,
      html_path: htmlPath,
      entry_directory: entryDirectory,
      relative_entry_directory: relativeEntryDirectory,
      bytes: buffer.length,
      sha256: sha256(buffer),
      resource_signals: resourceSignals(html),
    };
  } catch (error) {
    return {
      expected: true,
      status: "missing",
      main_url: mainUrl,
      html_path: htmlPath,
      entry_directory: entryDirectory,
      relative_entry_directory: relativeEntryDirectory,
      bytes: 0,
      sha256: "",
      resource_signals: resourceSignals(""),
    };
  }
}

async function realEntryResourceReadiness(realEntryHtml) {
  const baseResult = {
    expected: true,
    status: "ready",
    total_resources: 0,
    ready_resources: 0,
    missing_resources: 0,
    bytes: 0,
    scripts: [],
    stylesheets: [],
    missing: [],
  };

  if (!realEntryHtml || realEntryHtml.status !== "ready" || !realEntryHtml.html_path) {
    return {
      ...baseResult,
      status: "entry-not-ready",
    };
  }

  const html = await readFile(realEntryHtml.html_path, "utf8");
  const references = extractEntryResourceReferences(html);

  async function readResource(reference) {
    const path = resourcePathFromUrl(realEntryHtml.entry_directory, reference.url);
    if (!path) return { missing: { ...reference, path: "", reason: "non-local-url" } };
    try {
      const buffer = await readFile(path);
      return {
        ready: {
          ...reference,
          path,
          bytes: buffer.length,
          sha256: sha256(buffer),
        },
      };
    } catch (error) {
      return {
        missing: {
          ...reference,
          path,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const scriptResults = await Promise.all(references.scripts.map(readResource));
  const stylesheetResults = await Promise.all(references.stylesheets.map(readResource));
  const scripts = scriptResults.flatMap((result) => result.ready ? [result.ready] : []);
  const stylesheets = stylesheetResults.flatMap((result) => result.ready ? [result.ready] : []);
  const missing = [...scriptResults, ...stylesheetResults].flatMap((result) => result.missing ? [result.missing] : []);
  const totalResources = references.scripts.length + references.stylesheets.length;
  const readyResources = scripts.length + stylesheets.length;

  return {
    expected: true,
    status: missing.length === 0 ? "ready" : "missing",
    total_resources: totalResources,
    ready_resources: readyResources,
    missing_resources: missing.length,
    bytes: [...scripts, ...stylesheets].reduce((sum, resource) => sum + Number(resource.bytes || 0), 0),
    scripts,
    stylesheets,
    missing,
  };
}

function fixtureBridgeScript(plan, id, title) {
  const code = featureCode(plan);
  const triggerType = stringOrEmpty(plan?.activation?.trigger_type);
  const triggerQuery = stringOrEmpty(plan?.activation?.query);
  const bridgeApiProbeIds = htmlText(JSON.stringify(REAL_ENTRY_BRIDGE_API_PROBE_IDS));
  return `<script data-atools-real-entry-fixture-bridge="true">
(function(){
  var pluginId = ${jsString(id)};
  var featureCode = ${jsString(code)};
  var fixtureErrors = [];
  var bridgeApiProbeIds = ${bridgeApiProbeIds};
  function mark(name, value) {
    if (document.body) document.body.setAttribute(name, String(value));
  }
  function errorText(value) {
    if (value && value.message) return String(value.message);
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (error) { return String(value); }
    }
    return String(value || 'error');
  }
  function recordError(value) {
    fixtureErrors.push(errorText(value));
    mark('data-atools-real-entry-errors', fixtureErrors.length);
    mark('data-atools-real-entry-error-messages', fixtureErrors.slice(-5).join(' | ').slice(0, 800));
  }
  function safeStorage() {
    var values = Object.create(null);
    return {
      get length() { return Object.keys(values).length; },
      key: function(index) { return Object.keys(values)[Number(index) || 0] || null; },
      getItem: function(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function(key, value) {
        values[String(key)] = String(value);
      },
      removeItem: function(key) {
        delete values[String(key)];
      },
      clear: function() {
        values = Object.create(null);
      }
    };
  }
  function installStorageStub(name) {
    try {
      void window[name];
      return;
    } catch (error) {
      // Sandboxed iframes without allow-same-origin throw on storage access.
    }
    try {
      Object.defineProperty(window, name, {
        value: safeStorage(),
        configurable: true
      });
    } catch (error) {
      // Leave the original browser error visible if the property is not replaceable.
    }
  }
  installStorageStub('localStorage');
  installStorageStub('sessionStorage');
  function bridgeFunction(name) {
    return function(){ return Promise.resolve(null); };
  }
  function probeResult(id, passed, detail) {
    return { id: id, passed: passed === true, detail: detail ? String(detail).slice(0, 240) : '' };
  }
  async function probeBridgeApi(id, callback) {
    try {
      return probeResult(id, await callback() === true);
    } catch (error) {
      return probeResult(id, false, errorText(error));
    }
  }
  function markBridgeApiProbes(results) {
    var passed = results.filter(function(result) { return result.passed; }).length;
    var failedIds = results.filter(function(result) { return !result.passed; }).map(function(result) { return result.id; });
    mark('data-atools-real-entry-bridge-api-passed', passed);
    mark('data-atools-real-entry-bridge-api-total', results.length);
    mark('data-atools-real-entry-bridge-api-failed', failedIds.length);
    mark('data-atools-real-entry-bridge-api-failed-ids', failedIds.join(','));
    window.__atoolsRealEntryFixture.bridgeApiProbes = results;
    return { passed: passed, total: results.length, failedIds: failedIds };
  }
  function fixturePath(name) {
    return '/tmp/atools-real-entry-fixture/' + String(name || '');
  }
  function allDocsResult() {
    var rows = [];
    rows.rows = rows;
    rows.total_rows = 0;
    rows.offset = 0;
    return rows;
  }
  var fixtureContext = {
    pluginId: pluginId,
    pluginName: ${jsString(title)},
    featureCode: featureCode,
    code: featureCode,
    type: ${jsString(triggerType)},
    query: ${jsString(triggerQuery)},
    text: ${jsString(triggerQuery)},
    payload: ${jsString(triggerQuery)},
    option: {},
    args: [],
    files: [],
    paths: [],
    pluginEnterParams: {
      code: featureCode,
      type: ${jsString(triggerType)},
      payload: ${jsString(triggerQuery)},
      text: ${jsString(triggerQuery)},
      option: {},
      args: [],
      files: [],
      paths: []
    },
    umami: {
      init: function(){ return undefined; },
      track: function(){ return undefined; },
      identify: function(){ return undefined; }
    }
  };
  var dbBridge = {
    get: function(){ return Promise.resolve(null); },
    put: function(){ return Promise.resolve({ ok: true, id: '', rev: 'fixture' }); },
    remove: function(){ return Promise.resolve({ ok: true, id: '', rev: 'fixture' }); },
    allDocs: function(){ return Promise.resolve(allDocsResult()); },
    postAttachment: function(){ return Promise.resolve({ ok: true, id: '', rev: 'fixture' }); },
    getAttachment: function(){ return Promise.resolve(null); },
    getAttachmentType: function(){ return Promise.resolve(''); },
    replicateStateFromCloud: function(){ return Promise.resolve({ ok: true, state: 'fixture' }); }
  };
  dbBridge.promises = dbBridge;
  var dbStorageBridge = safeStorage();
  var internalBridge = {
    getDevProjects: function(){ return Promise.resolve([]); },
    getRunningPlugins: function(){ return Promise.resolve([]); },
    updateDevProjectsOrder: function(){ return Promise.resolve({ success: true }); },
    importDevPlugin: function(){ return Promise.resolve({ success: false, error: 'fixture only' }); },
    scaffoldDevProject: function(){ return Promise.resolve({ success: false, error: 'fixture only' }); },
    upsertDevProjectByConfigPath: function(){ return Promise.resolve({ success: false, error: 'fixture only' }); }
  };
  var bridge = new Proxy({
    dbStorage: dbStorageBridge,
    db: dbBridge,
    internal: internalBridge,
    showNotification: function(){ return undefined; },
    copyText: function(){ return Promise.resolve(undefined); },
    getWindowType: function(){ return 'main'; },
    getPath: function(name){ return fixturePath(name); },
    getContext: function(){ return fixtureContext; },
    getFeatures: function(){ return []; },
    getFeature: function(){ return null; },
    getUser: function(){ return null; },
    getAppName: function(){ return 'ATools'; },
    getAppVersion: function(){ return '3.0.0'; },
    getNativeId: function(){ return 0; },
    isMacOS: function(){ return true; },
    isMacOs: function(){ return true; },
    isWindows: function(){ return false; },
    isLinux: function(){ return false; },
    isDev: function(){ return true; },
    readCurrentBrowserUrl: function(){ return ''; },
    getCurrentBrowserUrl: function(){ return ''; },
    readCurrentFolderPath: function(){ return ''; },
    onPluginEnter: function(callback){ if (typeof callback === 'function') window.addEventListener('atools-plugin-enter', function(){ callback(fixtureContext); }); },
    onPluginReady: function(callback){ if (typeof callback === 'function') window.addEventListener('atools-plugin-ready', function(){ callback(fixtureContext); }); },
    outPlugin: function(payload){ window.__atoolsRealEntryFixtureOutput = payload; return undefined; },
    setSubInput: function(){ return undefined; },
    setExpendHeight: function(){ return undefined; },
    setExpandHeight: function(){ return undefined; }
  }, {
    get: function(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'promises') return target;
      var fn = bridgeFunction(String(prop));
      target[prop] = fn;
      return fn;
    }
  });
  window.utools = window.utools || bridge;
  window.ztools = window.ztools || window.utools;
  function kyResponse() {
    return {
      text: function(){ return Promise.resolve(''); },
      json: function(){ return Promise.resolve({}); },
      blob: function(){ return Promise.resolve(new Blob([])); },
      arrayBuffer: function(){ return Promise.resolve(new ArrayBuffer(0)); }
    };
  }
  function kyStub() {
    return kyResponse();
  }
  var kyMethods = {
    get: function(){ return kyResponse(); },
    post: function(){ return kyResponse(); },
    put: function(){ return kyResponse(); },
    delete: function(){ return kyResponse(); },
    create: function(){ return kyStub; }
  };
  kyStub.get = kyMethods.get;
  kyStub.post = kyMethods.post;
  kyStub.put = kyMethods.put;
  kyStub.delete = kyMethods.delete;
  kyStub.create = kyMethods.create;
  window.services = window.services || {
    umami: fixtureContext.umami,
    qrDecode: function(){ return Promise.resolve([]); },
    formatMybatisLog: function(value){ return String(value || ''); }
  };
  window.Preload = window.Preload || {
    umami: fixtureContext.umami,
    ky: kyStub,
    loadPage: function(){ return Promise.resolve(null); },
    downloader: function(){},
    wallpaper: function(){ return Promise.resolve(undefined); }
  };
  window.__atoolsRealEntryFixture = {
    pluginId: pluginId,
    pluginName: ${jsString(title)},
    featureCode: featureCode,
    triggerType: ${jsString(triggerType)},
    query: ${jsString(triggerQuery)},
    errors: fixtureErrors,
    bridgeApiProbeIds: bridgeApiProbeIds,
    bridgeApiProbes: []
  };
  async function runBridgeApiProbes() {
    var key = 'atools-fixture-probe';
    return Promise.all([
      probeBridgeApi('fixture-bridge-get-path', async function(){
        return typeof window.utools.getPath('home') === 'string' && window.utools.getPath('home').indexOf('/tmp/atools-real-entry-fixture/') === 0;
      }),
      probeBridgeApi('fixture-bridge-context', async function(){
        var context = window.utools.getContext();
        return context && context.pluginId === pluginId && context.featureCode === featureCode && context.pluginEnterParams && context.pluginEnterParams.code === featureCode;
      }),
      probeBridgeApi('fixture-bridge-db-storage', async function(){
        window.utools.dbStorage.setItem(key, 'ok');
        var stored = window.utools.dbStorage.getItem(key);
        window.utools.dbStorage.removeItem(key);
        return stored === 'ok' && window.utools.dbStorage.getItem(key) === null;
      }),
      probeBridgeApi('fixture-bridge-db-all-docs', async function(){
        var docs = await window.utools.db.allDocs();
        return Array.isArray(docs) && docs.rows === docs && docs.total_rows === 0;
      }),
      probeBridgeApi('fixture-bridge-app-identity', async function(){
        return window.utools.getAppName() === 'ATools' && typeof window.utools.getAppVersion() === 'string' && window.utools.getNativeId() === 0;
      }),
      probeBridgeApi('fixture-bridge-system-flags', async function(){
        return window.utools.isMacOS() === true && window.utools.isWindows() === false && window.utools.isLinux() === false && window.utools.isDev() === true;
      }),
      probeBridgeApi('fixture-bridge-preload-ky', async function(){
        var ky = window.Preload && window.Preload.ky;
        var created = ky && ky.create && ky.create();
        var response = created && created.get && created.get('/fixture');
        var json = response && response.json && await response.json();
        return !!ky && typeof created === 'function' && json && typeof json === 'object';
      }),
      probeBridgeApi('fixture-bridge-services', async function(){
        return !!window.services && window.services.umami.track() === undefined && window.services.formatMybatisLog('select 1') === 'select 1';
      }),
      probeBridgeApi('fixture-bridge-web-storage', async function(){
        window.localStorage.setItem(key, 'ok');
        window.sessionStorage.setItem(key, 'session');
        var passed = window.localStorage.getItem(key) === 'ok' && window.sessionStorage.getItem(key) === 'session';
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
        return passed && window.localStorage.getItem(key) === null;
      })
    ]);
  }
  window.addEventListener('error', function(event){
    recordError(event && (event.message || event.error) || 'error');
  });
  window.addEventListener('unhandledrejection', function(event){
    recordError(event && event.reason || 'unhandledrejection');
  });
  function ready() {
    mark('data-atools-real-entry-fixture', true);
    mark('data-atools-real-entry-plugin-id', pluginId);
    mark('data-atools-real-entry-feature-code', featureCode);
    mark('data-atools-real-entry-bridge-present', !!window.utools);
    mark('data-atools-real-entry-ztools-alias', window.ztools === window.utools);
    mark('data-atools-real-entry-errors', fixtureErrors.length);
    mark('data-atools-real-entry-error-messages', fixtureErrors.slice(-5).join(' | ').slice(0, 800));
    window.dispatchEvent(new CustomEvent('atools-plugin-enter', { detail: fixtureContext }));
    setTimeout(async function(){
      window.dispatchEvent(new CustomEvent('atools-plugin-ready', { detail: fixtureContext }));
      mark('data-atools-real-entry-ready', true);
      var bridgeApiProbes = await runBridgeApiProbes();
      markBridgeApiProbes(bridgeApiProbes);
      var probeResults = [
        { id: 'real-entry-fixture-ready', passed: document.body && document.body.getAttribute('data-atools-real-entry-ready') === 'true' },
        { id: 'real-entry-fixture-bridge', passed: !!window.utools },
        { id: 'real-entry-fixture-ztools-alias', passed: window.ztools === window.utools },
        { id: 'real-entry-fixture-identity', passed: document.body && document.body.getAttribute('data-atools-real-entry-plugin-id') === pluginId && document.body.getAttribute('data-atools-real-entry-feature-code') === featureCode },
        { id: 'real-entry-fixture-errors', passed: fixtureErrors.length === 0 }
      ].concat(bridgeApiProbes);
      window.parent && window.parent.postMessage({
        __atools_real_entry_fixture_probe__: true,
        pluginId: pluginId,
        featureCode: featureCode,
        probes: probeResults,
        errors: fixtureErrors,
        bridgeApiProbes: bridgeApiProbes
      }, '*');
    }, 80);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
<\/script>`;
}

function injectFixtureBridge(html, bridgeScript) {
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, (tag) => `${tag}\n${bridgeScript}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, (tag) => `${tag}\n<head>\n${bridgeScript}\n</head>`);
  }
  return `${bridgeScript}\n${html}`;
}

function resourceByUrl(resources, kind, url) {
  const list = kind === "stylesheet" ? resources.stylesheets : resources.scripts;
  return list.find((resource) => resource.url === url);
}

async function copyRuntimeSupportFile(sourcePath, outputPath, copied) {
  const sourceStat = await safeStat(sourcePath);
  if (!sourceStat?.isFile()) return;
  const key = outputPath;
  if (copied.has(key)) return;
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(sourcePath, outputPath);
  copied.set(key, sourceStat.size);
}

async function copySiblingRuntimeSupportFiles(resources, outputDir, copied) {
  const scriptDirectories = [...new Set((resources?.scripts || []).map((resource) => dirname(resource.path)))];
  for (const directory of scriptDirectories) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!RUNTIME_SUPPORT_EXTENSIONS.has(extension)) continue;
      await copyRuntimeSupportFile(join(directory, entry.name), join(outputDir, entry.name), copied);
    }
  }
}

async function copyRuntimeSupportTree(sourceRoot, outputRoot, copied) {
  let entries = [];
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const sourcePath = join(sourceRoot, entry.name);
    const outputPath = join(outputRoot, entry.name);
    if (entry.isDirectory()) {
      await copyRuntimeSupportTree(sourcePath, outputPath, copied);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!RUNTIME_SUPPORT_EXTENSIONS.has(extension)) continue;
    await copyRuntimeSupportFile(sourcePath, outputPath, copied);
  }
}

function cleanCssDependencyUrl(value) {
  const url = stringOrEmpty(value).trim();
  if (!url || url.startsWith("#")) return "";
  if (/^(?:data:|blob:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return "";
  return url.split("#")[0].split("?")[0];
}

function extractCssDependencyUrls(css) {
  const urls = [];
  for (const match of String(css || "").matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const url = cleanCssDependencyUrl(match[2]);
    if (url) urls.push(url);
  }
  for (const match of String(css || "").matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi)) {
    const url = cleanCssDependencyUrl(match[2]);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

function browserResolvedOutputPath(relativeUrl, basePath) {
  const resolved = new URL(relativeUrl, `http://atools-fixture.local/${basePath || "fixture.html"}`);
  return decodeURIComponent(resolved.pathname.replace(/^\/+/, ""));
}

async function copyCssRuntimeSupportFiles(cssPath, cssOutputBasePath, outputDir, copied, visited = new Set()) {
  const sourceStat = await safeStat(cssPath);
  if (!sourceStat?.isFile()) return;
  const visitedKey = `${cssPath}\0${cssOutputBasePath}`;
  if (visited.has(visitedKey)) return;
  visited.add(visitedKey);

  let css = "";
  try {
    css = await readFile(cssPath, "utf8");
  } catch {
    return;
  }

  for (const dependencyUrl of extractCssDependencyUrls(css)) {
    const sourcePath = resolve(dirname(cssPath), dependencyUrl);
    const sourceDependencyStat = await safeStat(sourcePath);
    if (!sourceDependencyStat?.isFile()) continue;
    const extension = extname(sourcePath).toLowerCase();
    if (!RUNTIME_SUPPORT_EXTENSIONS.has(extension)) continue;
    const outputRelativePath = browserResolvedOutputPath(dependencyUrl, cssOutputBasePath);
    if (!outputRelativePath) continue;
    const outputPath = join(outputDir, outputRelativePath);
    await copyRuntimeSupportFile(sourcePath, outputPath, copied);
    if (extension === ".css") {
      await copyCssRuntimeSupportFiles(sourcePath, outputRelativePath, outputDir, copied, visited);
    }
  }
}

async function copyRootRuntimeSupportFiles(plan, outputDir, copied) {
  const sourceRoot = stringOrEmpty(plan?.source_path);
  if (!sourceRoot) return;
  for (const directoryName of ["json"]) {
    const sourcePath = join(resolve(sourceRoot), directoryName);
    const sourceStat = await safeStat(sourcePath);
    if (!sourceStat?.isDirectory()) continue;
    await copyRuntimeSupportTree(sourcePath, join(outputDir, directoryName), copied);
  }
}

async function copyRuntimeSupportFiles(plan, resources, outputDir) {
  const copied = new Map();
  await mkdir(outputDir, { recursive: true });
  await copySiblingRuntimeSupportFiles(resources, outputDir, copied);
  for (const stylesheet of resources?.stylesheets || []) {
    await copyCssRuntimeSupportFiles(stylesheet.path, "fixture.html", outputDir, copied);
  }
  await copyRootRuntimeSupportFiles(plan, outputDir, copied);
  return {
    files: copied.size,
    bytes: [...copied.values()].reduce((sum, bytes) => sum + bytes, 0),
  };
}

async function realEntryExecutionFixture(plan, id, title, realEntryHtml, realEntryResources, options) {
  const fixtureOutputDir = stringOrEmpty(options?.fixtureOutputDir);
  const baseResult = {
    expected: Boolean(fixtureOutputDir),
    status: fixtureOutputDir ? "not-generated" : "disabled",
    path: "",
    relative_path: "",
    url: "",
    bytes: 0,
    sha256: "",
    inlined_scripts: 0,
    inlined_stylesheets: 0,
    runtime_support_files: 0,
    runtime_support_bytes: 0,
    bridge_api_probe_ids: [],
    probe_ids: [],
  };

  if (!fixtureOutputDir) return baseResult;
  if (!realEntryHtml || realEntryHtml.status !== "ready" || !realEntryHtml.html_path) {
    return { ...baseResult, status: "entry-not-ready" };
  }
  if (realEntryResources?.missing_resources > 0) {
    return { ...baseResult, status: "resource-missing" };
  }

  let html = await readFile(realEntryHtml.html_path, "utf8");
  let inlinedScripts = 0;
  let inlinedStylesheets = 0;

  html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi, (tag, beforeSrc, _quote, src, afterSrc) => {
    if (!isLocalResourceUrl(src)) return tag;
    const resource = resourceByUrl(realEntryResources, "script", src);
    if (!resource) return tag;
    const attrs = `${beforeSrc}${afterSrc}`.replace(/\s(src)\s*=\s*(["'])([^"']*)\2/ig, "");
    inlinedScripts += 1;
    return `<script${attrs} data-atools-inlined-script-src="${htmlAttribute(src)}">\n${htmlText(readFileSyncCache.get(resource.path))}\n<\/script>`;
  });

  html = html.replace(/<link\b([^>]*)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (tag, beforeHref, _quote, href, afterHref) => {
    const attrs = `${beforeHref}${afterHref}`;
    if (!/\brel\s*=\s*(["'])?stylesheet\1?/i.test(attrs) || !isLocalResourceUrl(href)) return tag;
    const resource = resourceByUrl(realEntryResources, "stylesheet", href);
    if (!resource) return tag;
    inlinedStylesheets += 1;
    return `<style data-atools-inlined-stylesheet-href="${htmlAttribute(href)}">\n${htmlText(readFileSyncCache.get(resource.path))}\n</style>`;
  });

  html = injectFixtureBridge(html, fixtureBridgeScript(plan, id, title));
  const outputDir = resolve(fixtureOutputDir);
  const fileName = `${String(Number(plan?.order || 0)).padStart(3, "0")}-${slugPart(id)}-${slugPart(featureCode(plan))}.html`;
  const outputPath = join(outputDir, fileName);
  const runtimeSupport = await copyRuntimeSupportFiles(plan, realEntryResources, outputDir);
  const buffer = Buffer.from(html, "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, buffer);

  return {
    expected: true,
    status: "ready",
    path: outputPath,
    relative_path: fileName,
    url: pathToFileURL(outputPath).toString(),
    bytes: buffer.length,
    sha256: sha256(buffer),
    inlined_scripts: inlinedScripts,
    inlined_stylesheets: inlinedStylesheets,
    runtime_support_files: runtimeSupport.files,
    runtime_support_bytes: runtimeSupport.bytes,
    bridge_api_probe_ids: REAL_ENTRY_BRIDGE_API_PROBE_IDS,
    probe_ids: [
      "real-entry-fixture-bridge",
      "real-entry-fixture-ready",
      "real-entry-plugin-identity",
    ],
  };
}

function realEntryFixtureMatrixHtml(fixtures) {
  const fixtureJson = htmlText(JSON.stringify(fixtures));
  const rows = fixtures.map((fixture) => `    <tr data-fixture-key="${htmlAttribute(fixture.key)}" data-fixture-plugin-id="${htmlAttribute(fixture.plugin_id)}" data-fixture-feature-code="${htmlAttribute(fixture.feature_code)}">
      <td>${htmlAttribute(fixture.order)}</td>
      <td>${htmlAttribute(fixture.plugin_id)}</td>
      <td>${htmlAttribute(fixture.feature_code)}</td>
      <td data-fixture-status="${htmlAttribute(fixture.key)}">pending</td>
    </tr>`).join("\n");
  const frames = fixtures.map((fixture) => `    <iframe id="fixture-frame-${htmlAttribute(fixture.key)}" title="${htmlAttribute(fixture.plugin_id)} ${htmlAttribute(fixture.feature_code)}" src="${htmlAttribute(fixture.relative_path)}" data-fixture-key="${htmlAttribute(fixture.key)}" data-fixture-plugin-id="${htmlAttribute(fixture.plugin_id)}" data-fixture-feature-code="${htmlAttribute(fixture.feature_code)}"></iframe>`).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATools real entry fixture matrix</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 16px; background: #f6f7f9; color: #16181d; }
    h1 { margin: 0 0 12px; font-size: 18px; font-weight: 650; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; background: #ffffff; }
    th, td { border: 1px solid #d9dee7; padding: 6px 8px; font-size: 12px; text-align: left; }
    iframe { display: block; width: 100%; min-height: 420px; margin: 0 0 16px; border: 1px solid #c9d0dc; background: #ffffff; }
  </style>
</head>
<body data-atools-real-entry-fixture-matrix="true" data-atools-real-entry-matrix-expected-count="${htmlAttribute(fixtures.length)}" data-atools-real-entry-matrix-ready-count="0" data-atools-real-entry-matrix-error-count="0" data-atools-real-entry-matrix-all-ready="false">
  <h1>ATools real entry fixture matrix</h1>
  <table>
    <thead><tr><th>#</th><th>Plugin</th><th>Feature</th><th>Status</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <section aria-label="Real entry fixtures">
${frames}
  </section>
  <script>
(function(){
  var fixtures = ${fixtureJson};
  var results = Object.create(null);
  function findFixture(data) {
    return fixtures.find(function(item) {
      return item.plugin_id === data.pluginId && item.feature_code === data.featureCode;
    });
  }
  function statusCell(item) {
    return document.querySelector('[data-fixture-status="' + item.key + '"]');
  }
  function frameFor(item) {
    return document.getElementById('fixture-frame-' + item.key);
  }
  function ensureResult(item) {
    if (!results[item.key]) {
      results[item.key] = {
        key: item.key,
        pluginId: item.plugin_id,
        featureCode: item.feature_code,
        ready: false,
        bridgePresent: false,
        ztoolsAlias: false,
        identity: false,
        errors: 0,
        errorMessages: '',
        bridgeApiPassed: 0,
        bridgeApiTotal: 0,
        bridgeApiFailedIds: [],
        status: 'pending'
      };
    }
    return results[item.key];
  }
  function inspectFrame(item) {
    var result = ensureResult(item);
    var frame = frameFor(item);
    try {
      var body = frame && frame.contentDocument && frame.contentDocument.body;
      if (!body) return result;
      result.ready = body.getAttribute('data-atools-real-entry-ready') === 'true';
      result.bridgePresent = body.getAttribute('data-atools-real-entry-bridge-present') === 'true';
      result.ztoolsAlias = body.getAttribute('data-atools-real-entry-ztools-alias') === 'true';
      result.identity = body.getAttribute('data-atools-real-entry-plugin-id') === item.plugin_id
        && body.getAttribute('data-atools-real-entry-feature-code') === item.feature_code;
      result.errors = Number(body.getAttribute('data-atools-real-entry-errors') || '0') || 0;
      result.errorMessages = body.getAttribute('data-atools-real-entry-error-messages') || '';
      result.bridgeApiPassed = Number(body.getAttribute('data-atools-real-entry-bridge-api-passed') || '0') || 0;
      result.bridgeApiTotal = Number(body.getAttribute('data-atools-real-entry-bridge-api-total') || '0') || 0;
      result.bridgeApiFailedIds = String(body.getAttribute('data-atools-real-entry-bridge-api-failed-ids') || '').split(',').filter(Boolean);
    } catch (error) {
      result.status = 'inaccessible';
      result.errors += 1;
    }
    result.status = result.ready && result.bridgePresent && result.ztoolsAlias && result.identity && result.errors === 0 && result.bridgeApiTotal > 0 && result.bridgeApiPassed === result.bridgeApiTotal
      ? 'ready'
      : 'pending';
    return result;
  }
  function render() {
    var values = fixtures.map(function(item) { return inspectFrame(item); });
    var readyCount = values.filter(function(result) { return result.status === 'ready'; }).length;
    var errorCount = values.reduce(function(sum, result) { return sum + Number(result.errors || 0) + (result.bridgeApiFailedIds || []).length; }, 0);
    values.forEach(function(result) {
      var item = fixtures.find(function(candidate) { return candidate.key === result.key; });
      var cell = item && statusCell(item);
      if (cell) cell.textContent = result.status + ' ready=' + result.ready + ' bridge=' + result.bridgePresent + ' ztools=' + result.ztoolsAlias + ' identity=' + result.identity + ' bridgeApi=' + result.bridgeApiPassed + '/' + result.bridgeApiTotal + ' bridgeApiFailed=' + (result.bridgeApiFailedIds || []).join(',') + ' errors=' + result.errors + (result.errorMessages ? ' messages=' + result.errorMessages : '');
    });
    document.body.setAttribute('data-atools-real-entry-matrix-ready-count', String(readyCount));
    document.body.setAttribute('data-atools-real-entry-matrix-error-count', String(errorCount));
    document.body.setAttribute('data-atools-real-entry-matrix-all-ready', String(readyCount === fixtures.length && errorCount === 0));
    window.__atoolsRealEntryFixtureMatrix = {
      expectedCount: fixtures.length,
      readyCount: readyCount,
      errorCount: errorCount,
      allReady: readyCount === fixtures.length && errorCount === 0,
      results: values
    };
  }
  window.addEventListener('message', function(event) {
    var data = event.data || {};
    if (!data.__atools_real_entry_fixture_probe__) return;
    var item = findFixture(data);
    if (!item) return;
    var result = ensureResult(item);
    result.ready = true;
    result.bridgePresent = true;
    result.ztoolsAlias = true;
    result.identity = true;
    result.errors = Array.isArray(data.errors) ? data.errors.length : Number(data.errors || 0) || 0;
    var bridgeApiProbes = Array.isArray(data.bridgeApiProbes) ? data.bridgeApiProbes : [];
    result.bridgeApiTotal = bridgeApiProbes.length;
    result.bridgeApiPassed = bridgeApiProbes.filter(function(probe) { return probe && probe.passed === true; }).length;
    result.bridgeApiFailedIds = bridgeApiProbes.filter(function(probe) { return !probe || probe.passed !== true; }).map(function(probe) { return probe && probe.id || 'unknown'; });
    render();
  });
  fixtures.forEach(function(item) {
    var frame = frameFor(item);
    if (frame) frame.addEventListener('load', function(){ setTimeout(render, 120); });
    ensureResult(item);
  });
  render();
  var matrixInterval = setInterval(render, 160);
  setTimeout(function(){ clearInterval(matrixInterval); render(); }, 6000);
})();
  <\/script>
</body>
</html>`;
}

async function realEntryFixtureMatrix(plans, options) {
  const fixtureOutputDir = stringOrEmpty(options?.fixtureOutputDir);
  const baseResult = {
    expected: Boolean(fixtureOutputDir),
    status: fixtureOutputDir ? "not-generated" : "disabled",
    fixture_count: 0,
    path: "",
    relative_path: "",
    url: "",
    bytes: 0,
    sha256: "",
    probe_ids: [],
  };

  if (!fixtureOutputDir) return baseResult;
  const fixtures = plans
    .filter((plan) => plan.real_entry_fixture?.status === "ready")
    .map((plan, index) => ({
      key: String(index + 1).padStart(3, "0"),
      order: plan.order,
      plugin_id: plan.plugin_id,
      feature_code: featureCode(plan),
      title: plan.title,
      relative_path: plan.real_entry_fixture.relative_path,
    }));
  if (fixtures.length === 0) return { ...baseResult, status: "no-fixtures" };

  const outputDir = resolve(fixtureOutputDir);
  const outputPath = join(outputDir, "index.html");
  const buffer = Buffer.from(realEntryFixtureMatrixHtml(fixtures), "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, buffer);

  return {
    expected: true,
    status: "ready",
    fixture_count: fixtures.length,
    path: outputPath,
    relative_path: "index.html",
    url: pathToFileURL(outputPath).toString(),
    bytes: buffer.length,
    sha256: sha256(buffer),
    probe_ids: [
      "real-entry-matrix-ready-count",
      "real-entry-matrix-error-count",
      "real-entry-matrix-all-ready",
    ],
  };
}

const readFileSyncCache = {
  values: new Map(),
  get(path) {
    return this.values.get(path) || "";
  },
  async fill(resources) {
    this.values.clear();
    for (const resource of [...(resources?.scripts || []), ...(resources?.stylesheets || [])]) {
      this.values.set(resource.path, await readFile(resource.path, "utf8"));
    }
  },
};

function previewSrcdoc(plan, manifest, id, title) {
  const code = featureCode(plan);
  const triggerType = stringOrEmpty(plan?.activation?.trigger_type);
  const triggerQuery = stringOrEmpty(plan?.activation?.query);
  return `<!doctype html>
<html>
<body data-external-plugin-id="${htmlAttribute(id)}" data-external-feature-code="${htmlAttribute(code)}" data-external-trigger-type="${htmlAttribute(triggerType)}">
<main data-ztools-ui-host-smoke="true">
  <h1>${htmlAttribute(title)}</h1>
  <p data-external-main-url="${htmlAttribute(stringOrEmpty(manifest?.main) || "index.html")}">${htmlAttribute(code)}</p>
  <p data-external-trigger-query="${htmlAttribute(triggerQuery)}">${htmlAttribute(triggerQuery)}</p>
</main>
<script>
(function(){
  function mark(name, value) {
    document.body.setAttribute(name, String(value));
  }
  window.addEventListener('atools-plugin-enter', function(){ mark('data-atools-plugin-enter', true); });
  window.addEventListener('atools-plugin-ready', function(){
    mark('data-atools-plugin-ready', true);
    setTimeout(reportProbeResults, 0);
  });
  var probeReported = false;
  function collectProbeResults() {
    return [
      { id: 'plugin-enter-event', passed: document.body.getAttribute('data-atools-plugin-enter') === 'true' },
      { id: 'plugin-ready-event', passed: document.body.getAttribute('data-atools-plugin-ready') === 'true' },
      { id: 'utools-bridge-present', passed: !!window.utools },
      { id: 'ztools-alias-present', passed: window.ztools === window.utools },
      {
        id: 'iframe-dom-identity',
        passed: document.body.getAttribute('data-external-plugin-id') === ${jsString(id)}
          && document.body.getAttribute('data-external-feature-code') === ${jsString(code)}
      }
    ];
  }
  function reportProbeResults() {
    if (probeReported) return;
    probeReported = true;
    mark('data-utools-bridge-present', !!window.utools);
    mark('data-ztools-alias-present', window.ztools === window.utools);
    var probeResults = collectProbeResults();
    window.__atoolsExternalUiHostSmoke = {
      pluginId: ${jsString(id)},
      featureCode: ${jsString(code)},
      triggerType: ${jsString(triggerType)},
      query: ${jsString(triggerQuery)},
      probeResults: probeResults
    };
    window.parent.postMessage({
      __atools_ui_host_probe_result__: true,
      pluginId: ${jsString(id)},
      featureCode: ${jsString(code)},
      probes: probeResults
    }, '*');
  }
  setTimeout(reportProbeResults, 160);
})();
<\/script>
</body>
</html>`;
}

function desktopAction(plan, manifest, id, title) {
  const pluginPath = installedPluginPath(plan);
  return {
    plugin_id: id,
    plugin_name: title,
    feature_code: featureCode(plan),
    main_url: stringOrEmpty(manifest?.main) || "index.html",
    plugin_path: pluginPath,
    preload_path: installedPreloadPath(pluginPath, manifest),
    expand_height: pluginWindowHeight(manifest?.pluginSetting?.height),
    plugin_permissions: normalizedPermissions(manifest?.permissions),
    payload: {
      trigger_type: stringOrEmpty(plan?.activation?.trigger_type),
      query: stringOrEmpty(plan?.activation?.query),
    },
  };
}

function webPreviewAction(plan, manifest, action) {
  return {
    plugin_id: action.plugin_id,
    plugin_name: action.plugin_name,
    feature_code: action.feature_code,
    main_url: "index.html",
    plugin_path: WEB_PREVIEW_PLUGIN_PATH,
    expand_height: action.expand_height,
    plugin_permissions: action.plugin_permissions,
    payload: {
      srcdoc: previewSrcdoc(plan, manifest, action.plugin_id, action.plugin_name),
      subInput: {
        placeholder: stringOrEmpty(plan?.activation?.feature_label) || action.feature_code,
        focus: false,
      },
      subInputValue: stringOrEmpty(plan?.activation?.query),
      outputItems: [],
    },
  };
}

function fixtureUrlForPluginPanel(fixture, options) {
  const fixtureBaseUrl = stringOrEmpty(options?.fixtureBaseUrl);
  if (!fixtureBaseUrl) return fixture.url || "";
  const base = fixtureBaseUrl.endsWith("/") ? fixtureBaseUrl : `${fixtureBaseUrl}/`;
  return new URL(fixture.relative_path || "", base).toString();
}

function realEntryPluginPanelSmoke(plan, action, fixture, options) {
  const baseResult = {
    expected: Boolean(fixture?.expected),
    status: fixture?.expected ? "not-generated" : "disabled",
    mode: "externalPlanRealFixture",
    url: "",
    fixture_path: "",
    fixture_url: "",
    probe_ids: [],
    expected_dom: {
      runtime_chips: ["运行状态", "桥接能力", "宿主探针"],
      body_mode: "iframe",
    },
  };
  if (!fixture?.expected) return baseResult;
  if (fixture.status !== "ready") {
    return { ...baseResult, status: fixture.status || "not-ready" };
  }
  const fixtureUrl = fixtureUrlForPluginPanel(fixture, options);
  const panelAction = {
    plugin_id: action.plugin_id,
    plugin_name: action.plugin_name,
    feature_code: action.feature_code,
    main_url: "index.html",
    plugin_path: WEB_PREVIEW_PLUGIN_PATH,
    expand_height: action.expand_height,
    plugin_permissions: action.plugin_permissions,
    payload: {
      iframeSrc: fixtureUrl,
      realEntryFixture: true,
      fixturePath: fixture.path,
      fixtureRelativePath: fixture.relative_path,
      subInput: {
        placeholder: stringOrEmpty(plan?.activation?.feature_label) || action.feature_code,
        focus: false,
      },
      subInputValue: stringOrEmpty(plan?.activation?.query),
      outputItems: [],
    },
  };
  return {
    expected: true,
    status: "ready",
    mode: "externalPlanRealFixture",
    url: previewUrl(options.baseUrl, panelAction),
    fixture_path: fixture.path,
    fixture_url: fixtureUrl,
    probe_ids: [
      "plugin-panel-iframe-src",
      "real-entry-fixture-ready",
      "real-entry-fixture-errors",
    ],
    expected_dom: {
      runtime_chips: ["运行状态", "桥接能力", "宿主探针"],
      body_mode: "iframe",
    },
  };
}

function browserUrlForOutput(relativePath, options) {
  const fixtureBaseUrl = stringOrEmpty(options?.fixtureBaseUrl);
  if (!fixtureBaseUrl) return "";
  const base = fixtureBaseUrl.endsWith("/") ? fixtureBaseUrl : `${fixtureBaseUrl}/`;
  return new URL(relativePath, base).toString();
}

function realEntryPluginPanelMatrixHtml(panels) {
  const panelJson = htmlText(JSON.stringify(panels));
  const rows = panels.map((panel) => `    <tr data-panel-key="${htmlAttribute(panel.key)}" data-panel-plugin-id="${htmlAttribute(panel.plugin_id)}" data-panel-feature-code="${htmlAttribute(panel.feature_code)}">
      <td>${htmlAttribute(panel.order)}</td>
      <td>${htmlAttribute(panel.plugin_id)}</td>
      <td>${htmlAttribute(panel.feature_code)}</td>
      <td data-panel-status="${htmlAttribute(panel.key)}">pending</td>
    </tr>`).join("\n");
  const frames = panels.map((panel) => `    <iframe id="plugin-panel-frame-${htmlAttribute(panel.key)}" title="${htmlAttribute(panel.plugin_id)} ${htmlAttribute(panel.feature_code)}" src="${htmlAttribute(panel.url)}" data-panel-key="${htmlAttribute(panel.key)}" data-panel-plugin-id="${htmlAttribute(panel.plugin_id)}" data-panel-feature-code="${htmlAttribute(panel.feature_code)}"></iframe>`).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATools real entry PluginPanel matrix</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 16px; background: #f6f7f9; color: #16181d; }
    h1 { margin: 0 0 12px; font-size: 18px; font-weight: 650; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; background: #ffffff; }
    th, td { border: 1px solid #d9dee7; padding: 6px 8px; font-size: 12px; text-align: left; }
    iframe { display: block; width: 100%; min-height: 620px; margin: 0 0 16px; border: 1px solid #c9d0dc; background: #ffffff; }
  </style>
</head>
<body data-atools-real-entry-plugin-panel-matrix="true" data-atools-real-entry-plugin-panel-matrix-expected-count="${htmlAttribute(panels.length)}" data-atools-real-entry-plugin-panel-matrix-ready-count="0" data-atools-real-entry-plugin-panel-matrix-error-count="0" data-atools-real-entry-plugin-panel-matrix-all-ready="false">
  <h1>ATools real entry PluginPanel matrix</h1>
  <table>
    <thead><tr><th>#</th><th>Plugin</th><th>Feature</th><th>Status</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <section aria-label="PluginPanel real entry fixtures">
${frames}
  </section>
  <script>
(function(){
  var panels = ${panelJson};
  var results = Object.create(null);
  function findPanel(data) {
    return panels.find(function(item) {
      return item.plugin_id === data.pluginId && item.feature_code === data.featureCode;
    });
  }
  function statusCell(item) {
    return document.querySelector('[data-panel-status="' + item.key + '"]');
  }
  function ensureResult(item) {
    if (!results[item.key]) {
      results[item.key] = {
        key: item.key,
        pluginId: item.plugin_id,
        featureCode: item.feature_code,
        ready: false,
        passed: 0,
        total: 0,
        failedIds: [],
        errorMessages: [],
        status: 'pending'
      };
    }
    return results[item.key];
  }
  function render() {
    var values = panels.map(function(item) { return ensureResult(item); });
    var readyCount = values.filter(function(result) { return result.status === 'ready'; }).length;
    var errorCount = values.reduce(function(sum, result) { return sum + (result.failedIds || []).length; }, 0);
    values.forEach(function(result) {
      var item = panels.find(function(candidate) { return candidate.key === result.key; });
      var cell = item && statusCell(item);
      if (cell) {
        var messages = (result.errorMessages || []).join(' | ').slice(0, 400);
        cell.textContent = result.status + ' passed=' + result.passed + '/' + result.total + ' failed=' + (result.failedIds || []).join(',') + (messages ? ' messages=' + messages : '');
      }
    });
    document.body.setAttribute('data-atools-real-entry-plugin-panel-matrix-ready-count', String(readyCount));
    document.body.setAttribute('data-atools-real-entry-plugin-panel-matrix-error-count', String(errorCount));
    document.body.setAttribute('data-atools-real-entry-plugin-panel-matrix-all-ready', String(readyCount === panels.length && errorCount === 0));
    window.__atoolsRealEntryPluginPanelMatrix = {
      expectedCount: panels.length,
      readyCount: readyCount,
      errorCount: errorCount,
      allReady: readyCount === panels.length && errorCount === 0,
      results: values
    };
  }
  window.addEventListener('message', function(event) {
    var data = event.data || {};
    if (!data.__atools_plugin_panel_real_entry_probe__) return;
    var item = findPanel(data);
    if (!item) return;
    var result = ensureResult(item);
    var total = Number(data.total || 0) || 0;
    var passed = Number(data.passed || 0) || 0;
    var failedIds = Array.isArray(data.failedIds) ? data.failedIds : [];
    var errorMessages = Array.isArray(data.errors) ? data.errors.map(function(error) { return String(error); }).filter(Boolean) : [];
    result.total = total;
    result.passed = passed;
    result.failedIds = failedIds;
    result.errorMessages = errorMessages;
    result.ready = total > 0 && passed === total && failedIds.length === 0;
    result.status = result.ready ? 'ready' : 'failed';
    render();
  });
  panels.forEach(ensureResult);
  render();
  var timeout = setTimeout(render, 8000);
  window.addEventListener('message', function(){ clearTimeout(timeout); timeout = setTimeout(render, 800); });
})();
  <\/script>
</body>
</html>`;
}

async function realEntryPluginPanelMatrix(plans, options) {
  const fixtureOutputDir = stringOrEmpty(options?.fixtureOutputDir);
  const baseResult = {
    expected: Boolean(fixtureOutputDir),
    status: fixtureOutputDir ? "not-generated" : "disabled",
    panel_count: 0,
    path: "",
    relative_path: "",
    url: "",
    browser_url: "",
    bytes: 0,
    sha256: "",
    probe_ids: [],
  };
  if (!fixtureOutputDir) return baseResult;
  const panels = plans
    .filter((plan) => plan.real_entry_plugin_panel?.status === "ready")
    .map((plan, index) => ({
      key: String(index + 1).padStart(3, "0"),
      order: plan.order,
      plugin_id: plan.plugin_id,
      feature_code: featureCode(plan),
      title: plan.title,
      url: plan.real_entry_plugin_panel.url,
    }));
  if (panels.length === 0) return { ...baseResult, status: "no-panels" };
  const outputDir = resolve(fixtureOutputDir);
  const relativePath = "plugin-panel-matrix.html";
  const outputPath = join(outputDir, relativePath);
  const buffer = Buffer.from(realEntryPluginPanelMatrixHtml(panels), "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, buffer);
  return {
    expected: true,
    status: "ready",
    panel_count: panels.length,
    path: outputPath,
    relative_path: relativePath,
    url: pathToFileURL(outputPath).toString(),
    browser_url: browserUrlForOutput(relativePath, options),
    bytes: buffer.length,
    sha256: sha256(buffer),
    probe_ids: [
      "plugin-panel-matrix-ready-count",
      "plugin-panel-matrix-error-count",
      "plugin-panel-matrix-all-ready",
    ],
  };
}

function previewUrl(baseUrl, action) {
  const url = new URL(baseUrl || "http://127.0.0.1:1420/");
  url.searchParams.set("parity", "1");
  url.searchParams.set("pluginHostSmoke", "externalPlan");
  url.searchParams.set("pluginHostSmokeAction", base64UrlJson(action));
  return url.toString();
}

function bridgeProbesFor(action) {
  return DEFAULT_BRIDGE_PROBES.map((probe) => ({
    ...probe,
    expected: probe.id === "iframe-dom-identity" ? action.plugin_id : probe.expected,
  }));
}

async function uiHostPlanFromActivationPlan(plan, options) {
  const manifest = await readManifest(plan.source_path);
  const id = pluginId(plan, manifest);
  const title = pluginTitle(plan, manifest);
  const action = desktopAction(plan, manifest, id, title);
  const webAction = webPreviewAction(plan, manifest, action);
  const realEntryHtml = await realEntryHtmlReadiness(plan, manifest);
  const realEntryResources = await realEntryResourceReadiness(realEntryHtml);
  await readFileSyncCache.fill(realEntryResources);
  const realEntryFixture = await realEntryExecutionFixture(plan, id, title, realEntryHtml, realEntryResources, options);
  const realEntryPluginPanel = realEntryPluginPanelSmoke(plan, action, realEntryFixture, options);
  return {
    order: Number(plan.order || 0),
    name: stringOrEmpty(plan.name) || id,
    title,
    plugin_id: id,
    source_path: stringOrEmpty(plan.source_path),
    runtime_status: stringOrEmpty(plan.runtime_status),
    activation: plan.activation || {},
    desktop_action: action,
    web_preview: {
      mode: "externalPlan",
      url: previewUrl(options.baseUrl, webAction),
      expected_dom: {
        plugin_id_attribute: id,
        feature_code_attribute: action.feature_code,
        runtime_chips: ["运行状态", "桥接能力"],
      },
    },
    iframe_ready: {
      expected: true,
      ready_event: "atools-plugin-ready",
      host_body_mode: "iframe",
    },
    real_entry_html: realEntryHtml,
    real_entry_resources: realEntryResources,
    real_entry_fixture: realEntryFixture,
    real_entry_plugin_panel: realEntryPluginPanel,
    screenshot_viewports: DEFAULT_SCREENSHOT_VIEWPORTS,
    bridge_probes: bridgeProbesFor(action),
    cleanup: plan.cleanup || {},
  };
}

function summarize(plans, skipped, realEntryMatrix, realEntryPluginPanelMatrix) {
  return {
    planned_samples: plans.length + skipped.length,
    ui_host_samples: plans.length,
    desktop_action_fixtures: plans.filter((plan) => plan.desktop_action).length,
    web_preview_actions: plans.filter((plan) => plan.web_preview?.url).length,
    iframe_ready_checks: plans.filter((plan) => plan.iframe_ready?.expected).length,
    screenshot_viewport_checks: plans.reduce((sum, plan) => sum + plan.screenshot_viewports.length, 0),
    bridge_probe_checks: plans.reduce((sum, plan) => sum + plan.bridge_probes.length, 0),
    real_entry_html_checks: plans.filter((plan) => plan.real_entry_html?.expected).length,
    real_entry_html_ready: plans.filter((plan) => plan.real_entry_html?.status === "ready").length,
    real_entry_html_missing: plans.filter((plan) => plan.real_entry_html?.expected && plan.real_entry_html?.status !== "ready").length,
    real_entry_html_bytes: plans.reduce((sum, plan) => sum + Number(plan.real_entry_html?.bytes || 0), 0),
    real_entry_resource_checks: plans.reduce((sum, plan) => sum + Number(plan.real_entry_resources?.total_resources || 0), 0),
    real_entry_resource_ready: plans.reduce((sum, plan) => sum + Number(plan.real_entry_resources?.ready_resources || 0), 0),
    real_entry_resource_missing: plans.reduce((sum, plan) => sum + Number(plan.real_entry_resources?.missing_resources || 0), 0),
    real_entry_resource_bytes: plans.reduce((sum, plan) => sum + Number(plan.real_entry_resources?.bytes || 0), 0),
    real_entry_fixture_count: plans.filter((plan) => plan.real_entry_fixture?.status === "ready").length,
    real_entry_fixture_bytes: plans.reduce((sum, plan) => sum + Number(plan.real_entry_fixture?.bytes || 0), 0),
    real_entry_fixture_matrix_count: realEntryMatrix?.status === "ready" ? Number(realEntryMatrix.fixture_count || 0) : 0,
    real_entry_fixture_matrix_bytes: Number(realEntryMatrix?.bytes || 0),
    real_entry_plugin_panel_checks: plans.filter((plan) => plan.real_entry_plugin_panel?.expected).length,
    real_entry_plugin_panel_ready: plans.filter((plan) => plan.real_entry_plugin_panel?.status === "ready").length,
    real_entry_plugin_panel_matrix_count: realEntryPluginPanelMatrix?.status === "ready" ? Number(realEntryPluginPanelMatrix.panel_count || 0) : 0,
    real_entry_plugin_panel_matrix_bytes: Number(realEntryPluginPanelMatrix?.bytes || 0),
    real_entry_fixture_bridge_api_probe_checks: plans.reduce((sum, plan) => (
      sum + (Array.isArray(plan.real_entry_fixture?.bridge_api_probe_ids) ? plan.real_entry_fixture.bridge_api_probe_ids.length : 0)
    ), 0),
    real_entry_fixture_runtime_support_files: plans.reduce((sum, plan) => sum + Number(plan.real_entry_fixture?.runtime_support_files || 0), 0),
    real_entry_fixture_runtime_support_bytes: plans.reduce((sum, plan) => sum + Number(plan.real_entry_fixture?.runtime_support_bytes || 0), 0),
    preload_expected_samples: plans.filter((plan) => plan.desktop_action.preload_path).length,
    permission_scoped_samples: plans.filter((plan) => plan.desktop_action.plugin_permissions.length > 0).length,
    skipped_samples: skipped.length,
  };
}

export async function buildZToolsPluginUiHostSmokeReport(planPath, options = {}) {
  const activationPlanPath = resolve(planPath);
  const activationPlan = await readJson(activationPlanPath);
  const inputPlans = Array.isArray(activationPlan.activation_plans) ? activationPlan.activation_plans : [];
  const plans = [];
  const skipped = [];

  for (const plan of inputPlans) {
    try {
      plans.push(await uiHostPlanFromActivationPlan(plan, options));
    } catch (error) {
      skipped.push({
        order: Number(plan?.order || 0),
        name: stringOrEmpty(plan?.name),
        source_path: stringOrEmpty(plan?.source_path),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const realEntryMatrix = await realEntryFixtureMatrix(plans, options);
  const pluginPanelMatrix = await realEntryPluginPanelMatrix(plans, options);

  return {
    generated_at: options.generatedAt || new Date().toISOString(),
    activation_plan_path: activationPlanPath,
    activation_plan_generated_at: activationPlan.generated_at || "",
    source: activationPlan.source || "",
    summary: summarize(plans, skipped, realEntryMatrix, pluginPanelMatrix),
    real_entry_fixture_matrix: realEntryMatrix,
    real_entry_plugin_panel_matrix: pluginPanelMatrix,
    ui_host_smoke_plans: plans,
    skipped,
  };
}

export async function writeZToolsPluginUiHostSmokeReport(report, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    plan: process.env.ZTOOLS_PLUGIN_ACTIVATION_PLAN || "output/ztools-plugin-activation-plan.json",
    output: "",
    baseUrl: "http://127.0.0.1:1420/",
    fixtureOutputDir: "",
    fixtureBaseUrl: "",
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plan") {
      options.plan = args[index + 1] || options.plan;
      index += 1;
    } else if (arg === "--output") {
      options.output = args[index + 1] || "";
      index += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = args[index + 1] || options.baseUrl;
      index += 1;
    } else if (arg === "--fixture-output") {
      options.fixtureOutputDir = args[index + 1] || "";
      index += 1;
    } else if (arg === "--fixture-base-url") {
      options.fixtureBaseUrl = args[index + 1] || "";
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

function printHumanSummary(report) {
  const summary = report.summary;
  console.log(`ZTools UI host smoke plan source: ${report.activation_plan_path}`);
  console.log(`UI host samples: ${summary.ui_host_samples}/${summary.planned_samples}`);
  console.log(`Checks: ${summary.iframe_ready_checks} iframe ready, ${summary.screenshot_viewport_checks} screenshot viewports, ${summary.bridge_probe_checks} bridge probes`);
  console.log(`Real entry HTML: ${summary.real_entry_html_ready}/${summary.real_entry_html_checks} ready, ${summary.real_entry_html_bytes} bytes`);
  console.log(`Real entry resources: ${summary.real_entry_resource_ready}/${summary.real_entry_resource_checks} ready, ${summary.real_entry_resource_bytes} bytes`);
  console.log(`Real entry fixtures: ${summary.real_entry_fixture_count} generated, ${summary.real_entry_fixture_bytes} bytes`);
  console.log(`Real entry fixture matrix: ${summary.real_entry_fixture_matrix_count} fixtures, ${summary.real_entry_fixture_matrix_bytes} bytes`);
  console.log(`Real entry PluginPanel fixtures: ${summary.real_entry_plugin_panel_ready}/${summary.real_entry_plugin_panel_checks} ready`);
  console.log(`Real entry PluginPanel matrix: ${summary.real_entry_plugin_panel_matrix_count} panels, ${summary.real_entry_plugin_panel_matrix_bytes} bytes`);
  if (report.ui_host_smoke_plans.length > 0) {
    const first = report.ui_host_smoke_plans[0];
    console.log(`Top UI host plan: ${first.plugin_id} -> ${first.activation.feature_code}`);
    console.log(`Preview URL: ${first.web_preview.url}`);
  }
  if (summary.skipped_samples > 0) {
    console.log(`Skipped: ${summary.skipped_samples}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildZToolsPluginUiHostSmokeReport(args.plan, {
    baseUrl: args.baseUrl,
    fixtureOutputDir: args.fixtureOutputDir,
    fixtureBaseUrl: args.fixtureBaseUrl,
  });
  if (args.output) {
    await writeZToolsPluginUiHostSmokeReport(report, args.output);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
}
