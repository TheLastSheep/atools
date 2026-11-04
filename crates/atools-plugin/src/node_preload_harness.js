'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const pluginDir = fs.realpathSync(process.env.ATOOLS_PLUGIN_DIR || process.cwd());
const preloadRel = process.env.ATOOLS_PRELOAD_REL || 'preload.js';
const action = process.env.ATOOLS_ACTION || 'inspect';
const targetName = process.env.ATOOLS_TARGET || '';
let rawArgsJson = process.env.ATOOLS_ARGS_JSON || '';
if (!rawArgsJson) {
  try {
    rawArgsJson = fs.readFileSync(0, 'utf8') || '{}';
  } catch (_) {
    rawArgsJson = '{}';
  }
}

if (path.isAbsolute(preloadRel)) {
  throw new Error(`NodePreloadBridge: absolute preload path is outside the selected package: ${preloadRel}`);
}
const declaredPreloadPath = path.resolve(pluginDir, preloadRel);
const preloadFromRoot = path.relative(pluginDir, declaredPreloadPath);
if (preloadFromRoot === '..' || preloadFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(preloadFromRoot)) {
  throw new Error(`NodePreloadBridge: preload path escapes the selected package: ${preloadRel}`);
}
// Resolve the entry symlink before loading so the executed file is still inside the
// selected package root. This entry check is not an OS sandbox or a full race defense.
const preloadPath = fs.realpathSync(declaredPreloadPath);
const canonicalPreloadFromRoot = path.relative(pluginDir, preloadPath);
if (canonicalPreloadFromRoot === '..' || canonicalPreloadFromRoot.startsWith(`..${path.sep}`)
  || path.isAbsolute(canonicalPreloadFromRoot)) {
  throw new Error(`NodePreloadBridge: resolved preload escapes the selected package: ${preloadRel}`);
}

const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      clipboard: {
        readText: () => '',
        writeText: () => {},
        readHTML: () => '',
        writeHTML: () => {},
        readImage: () => ({ isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
        writeImage: () => {},
        readBuffer: () => Buffer.alloc(0),
        writeBuffer: () => {},
        availableFormats: () => [],
        clear: () => {}
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
        showItemInFolder: () => {},
        trashItem: async () => {},
        beep: () => {}
      },
      ipcRenderer: {
        send: () => {},
        sendSync: () => null,
        invoke: async () => null,
        on: () => {},
        once: () => {},
        removeListener: () => {},
        removeAllListeners: () => {}
      },
      nativeImage: {
        createEmpty: () => ({ isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
        createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
        createFromDataURL: () => ({ isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
        createFromBuffer: () => ({ isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) })
      },
      screen: {
        getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }),
        getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }],
        getCursorScreenPoint: () => ({ x: 0, y: 0 })
      },
      desktopCapturer: {
        getSources: async () => []
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const memStorage = new Map();
const memDb = new Map();
const registeredTools = new Map();
const registeredProviders = new Map();

function normalizeToolName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

global.window = global;
global.self = global;
global.window.location = {
  href: 'file://' + path.join(pluginDir, 'index.html').replace(/\\/g, '/'),
  search: '',
  hash: '',
  pathname: path.join(pluginDir, 'index.html').replace(/\\/g, '/')
};
try {
  Object.defineProperty(global.window, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (ATools/3.0)',
      platform: process.platform === 'darwin' ? 'MacIntel' : (process.platform === 'win32' ? 'Win32' : 'Linux x86_64'),
      language: 'zh-CN'
    },
    configurable: true,
    writable: true
  });
} catch (_) {}
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.window.dispatchEvent = () => true;
global.CustomEvent = global.CustomEvent || class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};
global.window.CustomEvent = global.CustomEvent;
global.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
global.window.localStorage = {
  getItem: (k) => (memStorage.has(String(k)) ? memStorage.get(String(k)) : null),
  setItem: (k, v) => { memStorage.set(String(k), String(v)); },
  removeItem: (k) => { memStorage.delete(String(k)); },
  clear: () => { memStorage.clear(); }
};
global.window.sessionStorage = global.window.localStorage;
global.window.services = global.window.services || {};
global.window.exports = global.window.exports || {};
global.__atools_registered_tools__ = {};

const ztoolsApi = {
  getAppVersion: () => '3.0.0',
  getAppName: () => 'ATools',
  getNativeId: () => 'atools-node-bridge',
  isDev: () => false,
  isMacOS: () => process.platform === 'darwin',
  isMacOs: () => process.platform === 'darwin',
  isWindows: () => process.platform === 'win32',
  isLinux: () => process.platform === 'linux',
  isDarkColors: () => false,
  getWindowType: () => 'main',
  getUser: () => null,
  getPath: (name) => {
    switch (String(name || '')) {
      case 'home': return os.homedir();
      case 'temp': return os.tmpdir();
      case 'desktop': return path.join(os.homedir(), 'Desktop');
      case 'documents': return path.join(os.homedir(), 'Documents');
      case 'downloads': return path.join(os.homedir(), 'Downloads');
      default: return os.tmpdir();
    }
  },
  getPathForFile: (file) => (file && (file.path || file.name)) || '',
  getFileIcon: () => '',
  onPluginEnter: () => {},
  onPluginReady: () => {},
  onPluginOut: () => {},
  onPluginDetach: () => {},
  onDbPull: () => {},
  onMainPush: () => {},
  onMainInput: () => {},
  onSubInput: () => {},
  onSubInputChange: () => {},
  setSubInput: () => true,
  removeSubInput: () => true,
  setSubInputValue: () => true,
  setExpendHeight: () => true,
  setExpandHeight: () => true,
  showMainWindow: () => true,
  hideMainWindow: () => true,
  outPlugin: () => true,
  redirect: () => true,
  copyText: () => true,
  copyImage: () => true,
  copyFile: () => true,
  readText: () => '',
  readImage: () => null,
  getCopyedFiles: () => [],
  getCopiedFiles: () => [],
  clipboard: {
    onChange: () => () => {},
    getHistory: async () => ({ items: [], total: 0 }),
    paste: async () => true,
    deleteItem: async () => true,
    clearHistory: async () => true
  },
  showNotification: () => {},
  shellOpenPath: () => {},
  shellOpenExternal: () => {},
  shellShowItem: () => {},
  shellShowItemInFolder: () => {},
  shellTrashItem: async () => {},
  shellBeep: () => {},
  showOpenDialog: () => undefined,
  showSaveDialog: () => undefined,
  screenCapture: (cb) => { if (typeof cb === 'function') cb(''); },
  screenColorPick: (cb) => { if (typeof cb === 'function') cb({ hex: '#000000' }); },
  desktopCaptureSources: async () => [],
  getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }),
  getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }),
  getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }),
  screenToDipPoint: (pt) => pt || { x: 0, y: 0 },
  dipToScreenPoint: (pt) => pt || { x: 0, y: 0 },
  screenToDipRect: (r) => r || { x: 0, y: 0, width: 0, height: 0 },
  dipToScreenRect: (r) => r || { x: 0, y: 0, width: 0, height: 0 },
  createBrowserWindow: () => ({
    loadURL: () => {},
    show: () => {},
    hide: () => {},
    close: () => {},
    isDestroyed: () => false,
    webContents: { send: () => {}, executeJavaScript: async () => null, on: () => {} },
    on: () => {}
  }),
  sendToParent: () => {},
  startDrag: () => {},
  setFeature: () => true,
  setFeatures: () => true,
  getFeature: () => null,
  getFeatures: () => [],
  removeFeature: () => true,
  readCurrentBrowserUrl: async () => '',
  getCurrentBrowserUrl: async () => '',
  readCurrentFolderPath: async () => '',
  dbStorage: {
    getItem: (k) => (memStorage.has(String(k)) ? memStorage.get(String(k)) : null),
    setItem: (k, v) => { memStorage.set(String(k), v); },
    removeItem: (k) => { memStorage.delete(String(k)); }
  },
  db: {
    get: (id) => memDb.get(String(id)) || null,
    put: (doc) => {
      if (doc && doc._id) {
        const stored = Object.assign({}, doc, { _rev: '1-node' });
        memDb.set(String(doc._id), stored);
        return { id: doc._id, ok: true, rev: '1-node' };
      }
      return { ok: false };
    },
    remove: (docOrId) => {
      const id = typeof docOrId === 'string' ? docOrId : (docOrId && docOrId._id);
      memDb.delete(String(id));
      return { id, ok: true, rev: '2-node' };
    },
    allDocs: (prefix) => {
      const list = Array.from(memDb.values());
      if (typeof prefix === 'string') {
        return list.filter((d) => String(d._id || '').startsWith(prefix));
      }
      if (Array.isArray(prefix)) {
        const set = new Set(prefix.map(String));
        return list.filter((d) => set.has(String(d._id || '')));
      }
      return list;
    },
    bulkDocs: (docs) => (Array.isArray(docs) ? docs.map((d) => ztoolsApi.db.put(d)) : []),
    putAttachment: () => ({ ok: true, rev: '1-att' }),
    postAttachment: () => ({ ok: true, rev: '1-att' }),
    getAttachment: () => null,
    getAttachmentType: () => null,
    removeAttachment: () => ({ ok: true }),
    replicateStateFromCloud: () => null
  },
  registerTool: function(name, definitionOrHandler, maybeHandler) {
    let toolName = name;
    let handler = maybeHandler;
    let definition = definitionOrHandler;
    if (typeof name === 'object' && name) {
      handler = definitionOrHandler;
      definition = name;
      toolName = definition.name || definition.id || definition.title;
    } else if (typeof definitionOrHandler === 'function' && typeof maybeHandler !== 'function') {
      handler = definitionOrHandler;
      definition = {};
    }
    if (toolName && typeof handler === 'function') {
      registeredTools.set(String(toolName), handler);
      global.__atools_registered_tools__[String(toolName)] = {
        name: String(toolName),
        definition: definition || {},
        handler
      };
    }
    return true;
  },
  registerProvider: function(key, handler) {
    if (key && typeof handler === 'function') {
      registeredProviders.set(String(key), handler);
    }
    return true;
  },
  providers: {
    getProviders: async () => [],
    getDefaultProvider: async () => null,
    setDefaultProvider: async () => true,
    invokeProvider: async () => null
  }
};
ztoolsApi.db.promises = {
  get: async (id) => ztoolsApi.db.get(id),
  put: async (doc) => ztoolsApi.db.put(doc),
  remove: async (doc) => ztoolsApi.db.remove(doc),
  allDocs: async (p) => ztoolsApi.db.allDocs(p),
  bulkDocs: async (docs) => ztoolsApi.db.bulkDocs(docs),
  putAttachment: async () => ({ ok: true, rev: '1-att' }),
  postAttachment: async () => ({ ok: true, rev: '1-att' }),
  getAttachment: async () => null,
  getAttachmentType: async () => null,
  removeAttachment: async () => ({ ok: true }),
  replicateStateFromCloud: async () => null
};

global.ztools = ztoolsApi;
global.utools = ztoolsApi;

async function main() {
  const exported = require(preloadPath) || {};
  if (exported && typeof exported === 'object') {
    if (typeof exported.registerTools === 'function' && registeredTools.size === 0) {
      try { exported.registerTools(global.ztools); } catch (_) {}
    }
    if (exported.bridge && typeof exported.bridge === 'object') {
      for (const [k, fn] of Object.entries(exported.bridge)) {
        if (typeof fn === 'function' && !registeredTools.has(k)) {
          registeredTools.set(k, fn);
        }
      }
    }
  }

  const servicesObj = Object.assign({}, exported || {}, global.window.exports || {}, global.window.services || {});

  if (action === 'inspect') {
    const out = {
      ok: true,
      services: Object.keys(global.window.services || {}),
      exports: Object.keys(exported || {}),
      registeredTools: Array.from(registeredTools.keys())
    };
    process.stdout.write('\n__ATOOLS_JSON_BEGIN__\n' + JSON.stringify(out) + '\n__ATOOLS_JSON_END__\n');
    process.exit(0);
  }

  if (action === 'call_tool') {
    const parsedArgs = JSON.parse(rawArgsJson);
    let handler = registeredTools.get(targetName);
    if (!handler) {
      const norm = normalizeToolName(targetName);
      for (const [k, fn] of registeredTools.entries()) {
        if (normalizeToolName(k) === norm || norm.endsWith('_' + normalizeToolName(k))) {
          handler = fn;
          break;
        }
      }
    }
    if (!handler && typeof servicesObj[targetName] === 'function') {
      handler = servicesObj[targetName];
    }
    if (typeof handler !== 'function') {
      throw new Error(`NodePreloadBridge: tool handler '${targetName}' not found (registered: ${Array.from(registeredTools.keys()).join(', ')})`);
    }
    const result = await handler(parsedArgs);
    process.stdout.write('\n__ATOOLS_JSON_BEGIN__\n' + JSON.stringify({ ok: true, result: result === undefined ? null : result }) + '\n__ATOOLS_JSON_END__\n');
    process.exit(0);
  }

  if (action === 'call_service') {
    const parsedArgs = JSON.parse(rawArgsJson);
    const argsList = Array.isArray(parsedArgs) ? parsedArgs : [parsedArgs];
    const fn = servicesObj[targetName];
    if (typeof fn !== 'function') {
      throw new Error(`NodePreloadBridge: service method '${targetName}' not found`);
    }
    const result = await fn.apply(servicesObj, argsList);
    process.stdout.write('\n__ATOOLS_JSON_BEGIN__\n' + JSON.stringify({ ok: true, result: result === undefined ? null : result }) + '\n__ATOOLS_JSON_END__\n');
    process.exit(0);
  }

  throw new Error(`Unknown ATOOLS_ACTION: ${action}`);
}

main().catch((err) => {
  process.stdout.write('\n__ATOOLS_JSON_BEGIN__\n' + JSON.stringify({
    ok: false,
    error: (err && err.message) ? err.message : String(err)
  }) + '\n__ATOOLS_JSON_END__\n');
  process.exit(1);
});
