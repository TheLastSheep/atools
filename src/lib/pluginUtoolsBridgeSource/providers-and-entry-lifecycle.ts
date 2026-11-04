const part = `    key = String(key || '').trim();
    var declarations = _atoolsDeclaredProviders && typeof _atoolsDeclaredProviders === 'object'
      ? _atoolsDeclaredProviders
      : {};
    if (!key || !Object.prototype.hasOwnProperty.call(declarations, key)) {
      throw new Error('Provider is not declared in plugin.json: ' + key);
    }
    if (typeof handler !== 'function') {
      throw new Error('registerProvider requires a function handler: ' + key);
    }
    if (_registeredProviders[key]) {
      throw new Error('Provider already registered: ' + key);
    }
    _registeredProviders[key] = handler;
    return true;
  }
  function _providerInvoke(type, input, providerId) {
    return _nativeCall('providersInvoke', {
      providerType: String(type || ''),
      input: input && typeof input === 'object' ? input : {},
      providerId: providerId == null ? null : String(providerId)
    });
  }
  var _subInputBridge = (__ATOOLS_SUBINPUT_FACTORY__)(window, __ATOOLS_SUBINPUT_EPOCH__);
  var _lifecycleBridge = (__ATOOLS_LIFECYCLE_FACTORY__)(window, _pluginEnterAction);
  var _pluginFeatureExports = null;
  var _pluginClipboardCopyApi = (__ATOOLS_CLIPBOARD_COPY_FACTORY__)(window, {
    permission: _pluginClipboardCopyPermission,
    host: function() { return window.__atoolsHostClipboard; },
    writeImage: function(value) {
      var requireFunction = window.require;
      if (typeof requireFunction !== 'function') throw new Error('ERR_ATOOLS_CLIPBOARD_IMAGE_UNAVAILABLE: Electron adapter is not installed');
      var electron = requireFunction('electron');
      if (!electron || typeof electron !== 'object' || !electron.nativeImage || !electron.clipboard
          || typeof electron.clipboard.writeImage !== 'function') {
        throw new Error('ERR_ATOOLS_CLIPBOARD_IMAGE_UNAVAILABLE: NativeImage clipboard writer is not installed');
      }
      var image;
      if (typeof value === 'string') {
        if (value.indexOf('data:') === 0) {
          if (typeof electron.nativeImage.createFromDataURL !== 'function') {
            throw new Error('ERR_ATOOLS_CLIPBOARD_IMAGE_UNAVAILABLE: NativeImage data URL reader is not installed');
          }
          image = electron.nativeImage.createFromDataURL(value);
        } else {
          if (typeof electron.nativeImage.createFromPath !== 'function') {
            throw new Error('ERR_ATOOLS_CLIPBOARD_IMAGE_UNAVAILABLE: NativeImage path reader is not installed');
          }
          image = electron.nativeImage.createFromPath(value);
        }
      } else {
        var BufferConstructor = window.Buffer;
        if (!BufferConstructor || typeof BufferConstructor.from !== 'function'
            || typeof electron.nativeImage.createFromBuffer !== 'function') {
          throw new Error('ERR_ATOOLS_CLIPBOARD_IMAGE_UNAVAILABLE: NativeImage Buffer adapter is not installed');
        }
        image = electron.nativeImage.createFromBuffer(BufferConstructor.from(value));
      }
      return electron.clipboard.writeImage(image);
    }
  });
  window.utools = {
    db: {
      put: function(doc) { return _invokeFn("put_plugin_data", { pluginId: __PLUGIN_ID__, doc: doc }); },
      get: function(id) { return _invokeFn("get_plugin_data_item", { pluginId: __PLUGIN_ID__, docId: id }); },
      remove: function(idOrDoc) {
        var id = typeof idOrDoc === 'string' ? idOrDoc : idOrDoc._id;
        return _invokeFn("remove_plugin_data", { pluginId: __PLUGIN_ID__, docId: id });
      },
      allDocs: function(opts) {
        return _invokeFn("get_plugin_data", { pluginId: __PLUGIN_ID__ }).then(function(docs) {
          return _filterDbDocs(docs, opts);
        });
      },
      bulkDocs: function(docs) { return _invokeFn("put_plugin_data_bulk", { pluginId: __PLUGIN_ID__, docs: docs }); },
      putAttachment: function() { return _putAttachment(arguments); },
      postAttachment: function() { return _putAttachment(arguments); },
      getAttachment: function() { return _getAttachment(arguments); },
      getAttachmentType: function() { return _getAttachmentType(arguments); },
      replicateStateFromCloud: function() { return Promise.resolve(null); },
      promises: {}
    },
    dbStorage: _createDbStorage(),
    showNotification: function(msg) { return _invokeFn("show_notification", { message: String(msg) }); },
    clipboard: (__ATOOLS_CLIPBOARD_FACTORY__)(function(method, args) { return _nativeCall(method, args); }, function() {
      return window.__atoolsHostClipboard;
    }, _hostedIpcBridge.documentNonce, __ATOOLS_CLIPBOARD_HISTORY_CODEC_FACTORY__),
    network: {
      ipSnapshot: function() { return _nativeCall('getNativeIpSnapshot'); },
      request: function(options) {
        return _nativeCall('performNativeHttpRequest', { request: options || {} });
      }
    },
    http: {
      _headers: {},
      setHeaders: function(headers) { this._headers = headers && typeof headers === 'object' ? headers : {}; return this; },
      request: function(options) { return _nativeCall('performNativeHttpRequest', { request: options || {} }); },
      get: function(url, options) { return this.request(Object.assign({}, options || {}, { url: String(url || ''), method: 'GET', headers: this._headers })); },
      post: function(url, body, options) { return this.request(Object.assign({}, options || {}, { url: String(url || ''), method: 'POST', body: body, headers: this._headers })); }
    },
    translation: {
      translate: function(text, sourceLang, targetLang) {
        return _nativeCall('translateNativeText', {
          request: {
            text: String(text || ''),
            sourceLang: String(sourceLang || 'auto'),
            targetLang: String(targetLang || 'zh')
          }
        });
      }
    },
    processes: {
      list: function(query, limit) {
        return _nativeCall('listNativeProcesses', {
          query: String(query || ''),
          limit: Number.isFinite(Number(limit)) ? Number(limit) : 300
        });
      },
      terminate: function(pid, confirmed) {
        return _nativeCall('terminateNativeProcess', {
          pid: Number(pid),
          confirmed: confirmed === true
        });
      }
    },
    hosts: {
      read: function() { return _nativeCall('readNativeHosts'); },
      write: function(content, confirmed) {
        return _nativeCall('writeNativeHosts', {
          content: String(content || ''),
          confirmed: confirmed === true
        });
      }
    },
    todos: {
      list: function() { return _nativeCall('listNativeTodos'); },
      save: function(item) {
        item = item || {};
        return _nativeCall('saveNativeTodo', {
          id: item.id || null,
          title: String(item.title || ''),
          completed: typeof item.completed === 'boolean' ? item.completed : null
        });
      },
      delete: function(id, confirmed) {
        return _nativeCall('deleteNativeTodo', {
          id: String(id || ''),
          confirmed: confirmed === true
        });
      }
    },
    calculation: {
      evaluate: function(input) { return _nativeCall('calculateNativeSheet', { input: String(input || '') }); },
      history: function() { return _nativeCall('listNativeCalculationHistory'); },
      clearHistory: function(confirmed) { return _nativeCall('clearNativeCalculationHistory', { confirmed: confirmed === true }); }
    },
    codec: {
      transform: function(kind, input) { return _nativeCall('nativeCodecTransform', { kind: String(kind || ''), input: String(input || '') }); }
    },
    time: {
      snapshot: function() { return _nativeCall('nativeTimeSnapshot'); },
      convert: function(mode, value, timezone) { return _nativeCall('convertNativeTime', { mode: String(mode || ''), value: String(value || ''), timezone: timezone == null ? null : String(timezone) }); }
    },
    qr: {
      generate: function(text, size, errorCorrection) { return _nativeCall('generateNativeQr', { text: String(text || ''), size: Number(size || 256), errorCorrection: String(errorCorrection || 'M') }); }
    },
    json: {
      transform: function(input) { return _nativeCall('nativeJsonTransform', { input: String(input || '') }); }
    },
    color: {
      convert: function(input) { return _nativeCall('convertNativeColor', { input: String(input || '') }); }
    },
    copyText: _pluginClipboardCopyApi.copyText,
    copyImage: _pluginClipboardCopyApi.copyImage,
    copyFile: _pluginClipboardCopyApi.copyFile,
    getCopyedFiles: function() { return _nativeCall('getCopyedFiles').then(_normalizeCopiedFiles); },
    getCopiedFiles: function() { return _nativeCall('getCopyedFiles').then(_normalizeCopiedFiles); },
    hideMainWindowPasteText: function(text) { return _nativeCall('hideMainWindowPasteText', { text: String(text || '') }); },
    hideMainWindowPasteImage: function(image) { return _nativeCall('hideMainWindowPasteImage', { image: image }); },
    hideMainWindowPasteFile: function(file) { return _nativeCall('hideMainWindowPasteFile', { file: file }); },
    hideMainWindowTypeString: function(text) { return _nativeCall('hideMainWindowTypeString', { text: String(text || '') }); },
    outPlugin: function(data) {
      if (arguments.length === 0 || typeof data === 'boolean') {
        window.parent.postMessage({ __ipc_close__: true, isKill: data === true }, '*');
        return;
      }
      var items = data || [];
      if (Array.isArray(items)) {
        window.parent.postMessage({ __ipc_out__: true, data: items }, '*');
      } else {
        window.parent.postMessage({ __ipc_out__: true, data: [items] }, '*');
      }
    },
    redirect: function(label, payload) { return _nativeCall('redirect', { label: label, payload: payload }); },
    redirectHotKeySetting: function(cmdLabel, autocopy) {
      return _nativeCall('redirectHotKeySetting', {
        cmdLabel: String(cmdLabel || ''),
        autocopy: autocopy === true
      });
    },
    redirectAiModelsSetting: function() { return _nativeCall('redirectAiModelsSetting', {}); },
    createBrowserWindow: function(url, options, callback) {
      return _browserWindowBridge.createBrowserWindow(url, options, callback);
    },
    sendToParent: function(channel) {
      return _nativeCall('sendToParent', {
        channel: String(channel || ''),
        args: Array.prototype.slice.call(arguments, 1),
        windowType: _atoolsWindowType || 'main',
        browserWindowId: _atoolsBrowserWindowId || ''
      });
    },
    setSubInput: _subInputBridge.setSubInput,
    setSubInputValue: _subInputBridge.setSubInputValue,
    removeSubInput: _subInputBridge.removeSubInput,
    subInputFocus: _subInputBridge.subInputFocus,
    subInputBlur: _subInputBridge.subInputBlur,
    subInputSelect: _subInputBridge.subInputSelect,
    onSubInput: _subInputBridge.onSubInput,
    onPluginEnter: _lifecycleBridge.onPluginEnter,
    onPluginReady: function(cb) { window.addEventListener('atools-plugin-ready', function() { cb(); }, { once: true }); },
    onPluginOut: function(cb) {
      window.addEventListener('atools-plugin-out', function(event) { var detail = _eventDetail(event); cb(detail.isKill === true); });
      window.addEventListener('atools-plugin-hidden', function() { cb(false); });
    },
    onPluginDetach: function(cb) { window.addEventListener('atools-plugin-detach', function() { cb(); }); },
    onMainPush: function(callback, onSelect) {
      _mainPushCallback = typeof callback === 'function' ? callback : null;
      _mainPushSelectCallback = typeof onSelect === 'function' ? onSelect : null;
      if (_mainPushBridge) _mainPushBridge.register(callback, onSelect);
    },
    onDbPull: function(cb) {
      if (typeof cb === 'function') {
        _dbListeners.docs.push(cb);
      }
    },
    getPath: function(n) { return _invokeFn("system_get_path", { name: n }); },
    getNativeId: function() { return _getNativeId(); },
    getWebContentsId: _hostedIpcBridge.getWebContentsId,
    getAppName: function() { return __APP_NAME__; },
    getAppVersion: function() { return __APP_VERSION__; },
    isDev: function() { return false; },
    getFileIcon: function(filePath) { return _fileIconDataUrl(filePath); },
    getUser: function() { return null; },
    fetchUserServerTemporaryToken: function() {
      return Promise.reject(new Error('fetchUserServerTemporaryToken unsupported: user server temporary token is not available in the current local-only host'));
    },
    getPathForFile: function(file) {
      return _atoolsFileDropReceiver.getPathForFile(file);
    },
    shellOpenExternal: function(url) { return _invokeFn("shell_open", { url: url }); },
    shellOpenPath: function(path) { return _invokeFn("shell_open", { url: path }); },
    shellShowItemInFolder: function(path) { return _nativeCall('shellShowItemInFolder', { path: path }); },
    shellTrashItem: function(path) { return _nativeCall('shellTrashItem', { path: String(path || '') }); },
    shellBeep: function() { return _nativeCall('shellBeep', {}); },
    showOpenDialog: function(opts) { return _nativeCall('showOpenDialog', { options: opts || {} }); },
    showSaveDialog: function(opts) { return _nativeCall('showSaveDialog', { options: opts || {} }); },
    screenCapture: function(callback) { return _nativeCallbackCall('screenCapture', {}, callback); },
    screenColorPick: function(callback) { return _nativeCallbackCall('screenColorPick', {}, callback); },
    getPrimaryDisplay: _displayUnavailable,
    getAllDisplays: _displayUnavailable,
    getCursorScreenPoint: _displayUnavailable,
    getDisplayNearestPoint: _displayUnavailable,
    getDisplayMatching: _displayUnavailable,
    screenToDipPoint: _displayUnavailable,
    dipToScreenPoint: _displayUnavailable,
    screenToDipRect: _displayUnavailable,
    dipToScreenRect: _displayUnavailable,
    desktopCaptureSources: function(options) {
      return _nativeCall('desktopCaptureSources', { options: options || {} }).then(function(list) {
        return Array.isArray(list) ? list : [];
      }, function() {
        return [];
      });
    },
    readCurrentBrowserUrl: function() { return _nativeCall('readCurrentBrowserUrl'); },
    getCurrentBrowserUrl: function() { return _nativeCall('readCurrentBrowserUrl'); },
    readCurrentFolderPath: function() { return _nativeCall('readCurrentFolderPath'); },
    simulateKeyboardTap: function(key, modifiers) {
      var modifierList = Array.isArray(modifiers)
        ? modifiers
        : Array.prototype.slice.call(arguments, 1).filter(Boolean);
      return _nativeCall('simulateKeyboardTap', { key: key, modifiers: modifierList });
    },
    hideMainWindow: function(isRestorePreWindow) {
      window.parent.postMessage({
        __ipc_main_window__: true,
        action: 'hide',
        restorePreviousWindow: isRestorePreWindow !== false
      }, '*');
      return true;
    },
    showMainWindow: function() {
      window.parent.postMessage({ __ipc_main_window__: true, action: 'show' }, '*');
      return true;
    },
    getWindowType: function() { return _atoolsWindowType || 'main'; },
    findInPage: function(text, options) {
      window.parent.postMessage({
        __ipc_find_in_page__: true,
        text: String(text || ''),
        options: options || {}
      }, '*');
    },
    stopFindInPage: function(action) {
      window.parent.postMessage({
        __ipc_stop_find_in_page__: true,
        action: action || 'clearSelection'
      }, '*');
    },
    startDrag: typeof window.__atoolsStartDrag === 'function' ? window.__atoolsStartDrag : undefined,
    detachPlugin: function(options) {
      window.parent.postMessage({ __ipc_detach_plugin__: true, options: options || {} }, '*');
      return true;
    },
    detachPopupURL: function(options) {
      window.parent.postMessage({ __ipc_detach_plugin__: true, options: options || {} }, '*');
      return true;
    },
    setExpendHeight: function(height) { return Promise.resolve(_setPluginHeight(height)); },
    setExpandHeight: function(height) { return Promise.resolve(_setPluginHeight(height)); },
    setFeature: function(features) { return Promise.resolve(_setDynamicFeatures(features)); },
    setFeatures: function(features) { return Promise.resolve(_setDynamicFeatures(features)); },
    removeFeature: function(features) { return Promise.resolve(_removeDynamicFeatures(features)); },
    getFeatures: function() { return Promise.resolve(_dynamicFeatureList()); },
    registerTool: function(name, definitionOrHandler, maybeHandler) {
      var handler = typeof maybeHandler === 'function'
        ? maybeHandler
        : (typeof definitionOrHandler === 'function' ? definitionOrHandler : null);
      if (typeof name === 'object' && name) {
        name = name.name || name.id || name.title;
      }
      window.__atools_registered_tools__ = window.__atools_registered_tools__ || {};
      window.__atools_registered_tools__[name] = handler;
      window.parent.postMessage({ __ipc_register_tool__: true, name: name }, '*');
      return true;
    },
    registerProvider: _registerProvider,
    providers: {
      getProviders: function(type) {
        return _nativeCall('providersGetProviders', { providerType: type == null ? null : String(type) });
      },
      getDefaultProvider: function(type) {
        return _nativeCall('providersGetDefault', { providerType: String(type || '') });
      },
      setDefaultProvider: function(type, providerId) {
        return _nativeCall('providersSetDefault', {
          providerType: String(type || ''),
          providerId: String(providerId || '')
        });
      },
      invokeProvider: _providerInvoke
    },
    translate: function(text, options) {
      options = options && typeof options === 'object' ? options : {};
      return _providerInvoke('translation', {
        text: String(text || ''),
        from: options.from,
        to: options.to
      }, options.providerId || null);
    },
    ocr: function(image, options) {
      options = options && typeof options === 'object' ? options : {};
      return _providerInvoke('ocr', {
        image: String(image || ''),
        lang: options.lang
      }, options.providerId || null);
    },
    isDarkColors: function() { return _isDarkColors(); },
    isMacOS: function() { return navigator.platform.indexOf('Mac') > -1; },
    isMacOs: function() { return navigator.platform.indexOf('Mac') > -1; },
    isWindows: function() { return navigator.platform.indexOf('Win') > -1; },
    isLinux: function() {
      return /Linux/i.test(String(navigator.platform || '')) || /Linux/i.test(String(navigator.userAgent || ''));
    }
  };
  window.utools.db.promises = window.utools.db;
  var _ztoolsFacade = {};
  Object.keys(window.utools).forEach(function(key) {
    if (key === 'onPluginReady') {
      Object.defineProperty(_ztoolsFacade, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: _lifecycleBridge.onPluginEnter
      });
      return;
    }
    Object.defineProperty(_ztoolsFacade, key, {
      enumerable: true,
      configurable: true,
      get: function() { return window.utools[key]; },
      set: function(value) { window.utools[key] = value; }
    });
  });
  window.ztools = _ztoolsFacade;
  Object.defineProperty(window.utools, '__atoolsShowContextMenu', {
    enumerable: false,
    value: function(items) { return _nativeCall('showContextMenu', { items: items }); }
  });
  _installRuntimeCssStyleSheetPatch();
  _installRuntimePreinsertResourcePatch();
  _installRuntimeResourceObserver();

  // Choose exports or generic lifecycle after original preload scripts.
  var featureExports = _pluginFeatureExports = (__ATOOLS_FEATURE_EXPORTS_FACTORY__)(window, __ATOOLS_SUBINPUT_EPOCH__);
  if (_atoolsEntryMode !== 'preload') {
    window.addEventListener('atools-main-push-promote', function(event) { featureExports.start(event.detail); }, { once: true });
  }
  function startPluginEntry() {
    if (_atoolsEntryMode === 'preload') return;
    if (_mainPushBridge) { _mainPushBridge.boot(); window.dispatchEvent(new Event('atools-plugin-ready')); return; }
    if (_atoolsWindowType === 'main') featureExports.start(_pluginEnterAction({}));
    else {
      window.dispatchEvent(new CustomEvent('atools-plugin-enter', { detail: _pluginEnterAction({}) }));
      setTimeout(function() { window.dispatchEvent(new Event('atools-plugin-ready')); }, 50);
    }
  }
  _lifecycleBridge.startWhenDocumentReady(document, startPluginEntry);
})();
<\/script>`;
export default part;
