import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export function createMockEnvironment(pluginInfo) {
  const logs = [];
  const errors = [];
  const apiCalls = [];

  const dbStore = new Map();
  const dbStorageStore = new Map();
  const callbacks = {
    onPluginEnter: [],
    onPluginOut: [],
    onPluginReady: [],
    onPluginDetach: []
  };

  const utoolsMock = {
    // Lifecycle
    onPluginEnter(cb) {
      if (typeof cb === 'function') callbacks.onPluginEnter.push(cb);
    },
    onPluginOut(cb) {
      if (typeof cb === 'function') callbacks.onPluginOut.push(cb);
    },
    onPluginReady(cb) {
      if (typeof cb === 'function') callbacks.onPluginReady.push(cb);
    },
    onPluginDetach(cb) {
      if (typeof cb === 'function') callbacks.onPluginDetach.push(cb);
    },

    // Platform detection
    isMacOS() { return true; },
    isWindows() { return false; },
    isLinux() { return false; },
    isMacOs() { return true; },

    // Window & UI
    showNotification(body, clickFeatureCode) {
      apiCalls.push({ method: 'showNotification', args: [body, clickFeatureCode] });
    },
    hideMainWindow() {
      apiCalls.push({ method: 'hideMainWindow' });
    },
    showMainWindow() {
      apiCalls.push({ method: 'showMainWindow' });
    },
    setExpendHeight(height) {
      apiCalls.push({ method: 'setExpendHeight', args: [height] });
    },
    setSubInput(onChange, placeholder, isFocus) {
      apiCalls.push({ method: 'setSubInput', args: [placeholder, isFocus] });
    },
    removeSubInput() {
      apiCalls.push({ method: 'removeSubInput' });
    },
    setSubInputValue(val) {
      apiCalls.push({ method: 'setSubInputValue', args: [val] });
    },
    subInputBlur() {
      apiCalls.push({ method: 'subInputBlur' });
    },
    subInputFocus() {
      apiCalls.push({ method: 'subInputFocus' });
    },
    subInputSelect() {
      apiCalls.push({ method: 'subInputSelect' });
    },
    createBrowserWindow(url, options, callback) {
      apiCalls.push({ method: 'createBrowserWindow', args: [url, options] });
      return Promise.resolve({
        webContents: { send: () => {}, openDevTools: () => {} },
        on: () => {},
        show: () => {},
        hide: () => {},
        close: () => {},
        destroy: () => {}
      });
    },

    // Clipboard & Native
    copyText(text) {
      apiCalls.push({ method: 'copyText', args: [text] });
      return true;
    },
    copyImage(img) {
      apiCalls.push({ method: 'copyImage' });
      return true;
    },
    copyFile(file) {
      apiCalls.push({ method: 'copyFile', args: [file] });
      return true;
    },
    readCurrentBrowserUrl() {
      apiCalls.push({ method: 'readCurrentBrowserUrl' });
      return Promise.resolve('https://example.com');
    },
    readCurrentFolderPath() {
      apiCalls.push({ method: 'readCurrentFolderPath' });
      return Promise.resolve('/Users/test');
    },

    // Features
    getFeatures() {
      return pluginInfo.manifest ? (pluginInfo.manifest.features || []) : [];
    },
    setFeature(feature) {
      apiCalls.push({ method: 'setFeature', args: [feature] });
      return true;
    },
    removeFeature(code) {
      apiCalls.push({ method: 'removeFeature', args: [code] });
      return true;
    },

    // Env & User
    isDarkColors() {
      return false;
    },
    getUser() {
      return { avatar: '', nickname: 'TestUser', type: 'member' };
    },
    getAppVersion() {
      return '1.0.0';
    },
    getPath(name) {
      return `/mock/path/${name}`;
    },
    getFileIcon(file) {
      return 'data:image/png;base64,mock';
    },
    outPlugin() {
      apiCalls.push({ method: 'outPlugin' });
    },
    redirect(label, payload) {
      apiCalls.push({ method: 'redirect', args: [label, payload] });
    },
    showOpenDialog(options) {
      apiCalls.push({ method: 'showOpenDialog', args: [options] });
      return ['/mock/path/file.txt'];
    },
    showSaveDialog(options) {
      apiCalls.push({ method: 'showSaveDialog', args: [options] });
      return '/mock/path/save.txt';
    },
    shellOpenItem(path) {
      apiCalls.push({ method: 'shellOpenItem', args: [path] });
    },
    shellOpenExternal(url) {
      apiCalls.push({ method: 'shellOpenExternal', args: [url] });
    },
    shellShowItemInFolder(path) {
      apiCalls.push({ method: 'shellShowItemInFolder', args: [path] });
    },

    // DB
    db: {
      put(doc) {
        apiCalls.push({ method: 'db.put', id: doc._id });
        const rev = '1-' + Math.random().toString(36).substring(7);
        dbStore.set(doc._id, { ...doc, _rev: rev });
        return { id: doc._id, ok: true, rev };
      },
      get(id) {
        apiCalls.push({ method: 'db.get', id });
        return dbStore.get(id) || null;
      },
      remove(docOrId) {
        const id = typeof docOrId === 'string' ? docOrId : docOrId._id;
        apiCalls.push({ method: 'db.remove', id });
        const exists = dbStore.delete(id);
        return { id, ok: exists };
      },
      allDocs(key) {
        apiCalls.push({ method: 'db.allDocs', key });
        const res = [];
        for (const [k, v] of dbStore.entries()) {
          if (!key || k.startsWith(key)) res.push(v);
        }
        return res;
      },
      postAttachment(docId, attachment, type) {
        return { id: docId, ok: true, rev: '1-mock' };
      },
      getAttachment(docId) {
        return new Uint8Array([1, 2, 3]);
      },
      getAttachmentType(docId) {
        return 'text/plain';
      }
    },
    dbStorage: {
      setItem(key, value) {
        apiCalls.push({ method: 'dbStorage.setItem', key });
        dbStorageStore.set(key, value);
      },
      getItem(key) {
        apiCalls.push({ method: 'dbStorage.getItem', key });
        return dbStorageStore.get(key) || null;
      },
      removeItem(key) {
        apiCalls.push({ method: 'dbStorage.removeItem', key });
        dbStorageStore.delete(key);
      }
    }
  };

  return {
    logs,
    errors,
    apiCalls,
    callbacks,
    utoolsMock,
    dbStore,
    dbStorageStore
  };
}
