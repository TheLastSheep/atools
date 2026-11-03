import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, connectToTarget, cdpSend } from './chrome-cdp-smoke-utils.mjs';
import { createPluginServer } from './dynamic-test-server.mjs';

function buildInjectedBridgeScript(manifest, featureCode) {
  return `
(function() {
  const manifest = ${JSON.stringify(manifest)};
  const currentFeatureCode = ${JSON.stringify(featureCode)};
  
  // Shim mock storage
  const mockDbStorage = {};
  const mockDbDocs = {};
  
  window.__pluginAuditLogs = {
    events: [],
    apiCalls: [],
    errors: [],
    domReady: false,
    pluginEnterCalled: false,
  };

  function logCall(api, args, result) {
    window.__pluginAuditLogs.apiCalls.push({ api, args: String(args), timestamp: Date.now() });
  }

  const utoolsShim = {
    isDev: () => false,
    isMacOs: () => true,
    isWindows: () => false,
    isLinux: () => false,
    getAppVersion: () => '1.0.0',
    getPath: (name) => '/mock/path/' + name,
    showNotification: (body, title) => { logCall('showNotification', [body, title]); },
    showOpenDialog: (opts) => { logCall('showOpenDialog', opts); return ['/mock/file.txt']; },
    showSaveDialog: (opts) => { logCall('showSaveDialog', opts); return '/mock/save.txt'; },
    showMessageBox: (opts) => { logCall('showMessageBox', opts); return 0; },
    findInPage: (text, opts) => { logCall('findInPage', [text, opts]); },
    stopFindInPage: (action) => { logCall('stopFindInPage', action); },
    startDrag: (file) => { logCall('startDrag', file); },
    copyFile: (file) => { logCall('copyFile', file); return true; },
    copyImage: (img) => { logCall('copyImage', img); return true; },
    copyText: (text) => { logCall('copyText', text); return true; },
    getCopyedFiles: () => [],
    readCurrentBrowserUrl: () => Promise.resolve('https://github.com'),
    hideMainWindow: () => { logCall('hideMainWindow'); },
    showMainWindow: () => { logCall('showMainWindow'); },
    setExpendHeight: (h) => { logCall('setExpendHeight', h); },
    setSubInput: (onChange, placeholder, isFocus) => { logCall('setSubInput', [placeholder]); },
    removeSubInput: () => { logCall('removeSubInput'); },
    setSubInputValue: (val) => { logCall('setSubInputValue', val); },
    subInputBlur: () => { logCall('subInputBlur'); },
    subInputFocus: () => { logCall('subInputFocus'); },
    outPlugin: () => { logCall('outPlugin'); },
    redirect: (label, payload) => { logCall('redirect', [label, payload]); },
    
    // DB APIs
    db: {
      put: (doc) => {
        logCall('db.put', doc._id);
        const rev = 'rev_' + Date.now();
        mockDbDocs[doc._id] = { ...doc, _rev: rev };
        return { id: doc._id, ok: true, rev };
      },
      get: (id) => {
        logCall('db.get', id);
        return mockDbDocs[id] || null;
      },
      remove: (docOrId) => {
        const id = typeof docOrId === 'string' ? docOrId : docOrId._id;
        logCall('db.remove', id);
        if (mockDbDocs[id]) {
          delete mockDbDocs[id];
          return { id, ok: true };
        }
        return { id, ok: false, error: true, message: 'not found' };
      },
      allDocs: (key) => {
        logCall('db.allDocs', key);
        return Object.values(mockDbDocs);
      },
      bulkDocs: (docs) => {
        logCall('db.bulkDocs', docs.length);
        return docs.map(d => {
          const rev = 'rev_' + Date.now();
          mockDbDocs[d._id] = { ...d, _rev: rev };
          return { id: d._id, ok: true, rev };
        });
      },
      promises: {
        put: (doc) => Promise.resolve(utoolsShim.db.put(doc)),
        get: (id) => Promise.resolve(utoolsShim.db.get(id)),
        remove: (id) => Promise.resolve(utoolsShim.db.remove(id)),
        allDocs: (key) => Promise.resolve(utoolsShim.db.allDocs(key)),
      }
    },

    dbStorage: {
      setItem: (key, value) => {
        logCall('dbStorage.setItem', key);
        mockDbStorage[key] = value;
      },
      getItem: (key) => {
        logCall('dbStorage.getItem', key);
        return mockDbStorage[key] ?? null;
      },
      removeItem: (key) => {
        logCall('dbStorage.removeItem', key);
        delete mockDbStorage[key];
      },
      clear: () => {
        logCall('dbStorage.clear');
        for (const k in mockDbStorage) delete mockDbStorage[k];
      }
    },

    // Lifecycle
    _pluginEnterCallbacks: [],
    _pluginOutCallbacks: [],
    onPluginEnter: (cb) => {
      if (typeof cb === 'function') {
        utoolsShim._pluginEnterCallbacks.push(cb);
      }
    },
    onPluginOut: (cb) => {
      if (typeof cb === 'function') {
        utoolsShim._pluginOutCallbacks.push(cb);
      }
    },
    onPluginDetach: (cb) => {},
    onDbPull: (cb) => {},
    
    // Feature trigger
    triggerPluginEnter: (action) => {
      window.__pluginAuditLogs.pluginEnterCalled = true;
      const enterAction = action || {
        code: currentFeatureCode || (manifest.features && manifest.features[0] && manifest.features[0].code) || 'default',
        type: 'text',
        payload: 'test input',
      };
      for (const cb of utoolsShim._pluginEnterCallbacks) {
        try {
          cb(enterAction);
        } catch (e) {
          window.__pluginAuditLogs.errors.push('onPluginEnter handler error: ' + e.message);
        }
      }
    }
  };

  window.utools = utoolsShim;
  window.ztools = utoolsShim; // 100% Double Bridge

  // Catch unhandled errors
  window.addEventListener('error', (e) => {
    window.__pluginAuditLogs.errors.push(e.message || String(e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__pluginAuditLogs.errors.push('Unhandled Promise: ' + String(e.reason));
  });

  document.addEventListener('DOMContentLoaded', () => {
    window.__pluginAuditLogs.domReady = true;
  });
})();
`;
}

export { buildInjectedBridgeScript };
