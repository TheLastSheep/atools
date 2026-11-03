const part = `    var permission = _nativePermissionForMethod(method);
    var contextMenuMethod = method === 'showContextMenu';
    if (!permission && !contextMenuMethod) return Promise.reject(new Error('Unsupported native bridge method: ' + String(method || '(empty)')));
    var capturesIpc = method === 'sendTo' || method === 'sendToParent' || (method === 'browserWindowAction' && args && args.action === 'webContents.send');
    var permissionGate = capturesIpc || contextMenuMethod ? function(_permission, operation) { return operation(); } : _permissionPromise;
    return permissionGate(permission, function() {
      return new Promise(function(resolve, reject) {
      var id = ++_nativeReqId;
      _nativePending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_native_call__: true,
        reqId: id,
        method: method,
        hostedDocumentNonce: _hostedIpcBridge.documentNonce,
        args: args || {}
      }, '*');
      });
    });
  }
  var _pluginClipboardCopyPermissionPending = false;
  function _pluginClipboardCopyPermission() {
    if (_pluginPermissionAllowed('clipboard.write')) return true;
    if (_pluginClipboardCopyPermissionPending) return false;
    _pluginClipboardCopyPermissionPending = true;
    try {
      Promise.resolve(_requestPluginPermission('clipboard.write')).then(function() {
        _pluginClipboardCopyPermissionPending = false;
      }, function() {
        _pluginClipboardCopyPermissionPending = false;
      });
    } catch (_error) {
      _pluginClipboardCopyPermissionPending = false;
    }
    return false;
  }
  function _nativeCallbackCall(method, args, callback) {
    return _nativeCall(method, args).then(function(result) {
      if (typeof callback === 'function') callback(result);
      return result;
    });
  }
  function _browserWindowAction(id, action) {
    var args = Array.prototype.slice.call(arguments, 2);
    return _nativeCall('browserWindowAction', {
      id: String(id || ''),
      action: String(action || ''),
      args: args
    });
  }
  function _hostedBrowserWindowUnsupported(action) {
    return new Error(
      'ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: '
      + String(action || 'hosted BrowserWindow operation')
      + ' is unavailable for an isolated hosted BrowserWindow'
    );
  }
  var _hostedIpcBridge = (__ATOOLS_HOSTED_IPC_FACTORY__)(window, {
    webContentsId: __ATOOLS_WEB_CONTENTS_ID__, invoke: _nativeCall,
    reportError: function(error) { console.error('[ATools hosted ipcRenderer.sendTo]', error); }
  });
  var _atoolsBroadcastChannelBridge = (__ATOOLS_BROADCAST_CHANNEL_FACTORY__)(
    window, window.__ATOOLS_FRAME_TRANSPORT__, __ATOOLS_BROADCAST_PAYLOAD_MEASURE__, _hostedIpcBridge.documentNonce
  );
  var _atoolsFileDropReceiver = (__ATOOLS_FILE_DROP_RECEIVER_FACTORY__)(window, {
    pluginId: __PLUGIN_ID__, windowType: _atoolsWindowType, windowId: _atoolsBrowserWindowId,
    documentNonce: _hostedIpcBridge.documentNonce
  });
  function _emitChildIpc(channel, args) { _hostedIpcBridge.emit(channel, args); }
  var _ipcRenderer = _hostedIpcBridge.ipcRenderer;
  _ipcRenderer.send = _compatUnsupported('electron.ipcRenderer.send');
  _ipcRenderer.invoke = function(){ return Promise.reject(new Error('ERR_ATOOLS_ELECTRON_UNSUPPORTED: ipcRenderer.invoke')); };
  function _compatUnsupported(name) {
    return function() { throw new Error('ERR_ATOOLS_NODE_COMPAT_UNSUPPORTED: ' + name); };
  }
  function _compatPathParts(value) {
    return String(value || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean);
  }
  var _compatPath = {
    sep: '/',
    delimiter: ':',
    join: function() {
      var absolute = arguments.length > 0 && String(arguments[0] || '').startsWith('/');
      var parts = [];
      Array.prototype.forEach.call(arguments, function(value) { parts = parts.concat(_compatPathParts(value)); });
      return (absolute ? '/' : '') + parts.join('/');
    },
    resolve: function() { return _compatPath.join.apply(null, arguments); },
    dirname: function(value) {
      var text = String(value || '').split(String.fromCharCode(92)).join('/');
      while (text.endsWith('/')) text = text.slice(0, -1);
      var index = text.lastIndexOf('/');
      return index <= 0 ? (text.startsWith('/') ? '/' : '.') : text.slice(0, index);
    },
    basename: function(value) { return String(value || '').split(String.fromCharCode(92)).join('/').split('/').pop() || ''; },
    extname: function(value) {
      var name = _compatPath.basename(value);
      var index = name.lastIndexOf('.');
      return index > 0 ? name.slice(index) : '';
    }
  };
  var _compatFsPromises = {
    stat: function(){ return Promise.reject(new Error('File is unavailable in isolated Web plugin runtime')); },
    lstat: function(){ return Promise.reject(new Error('File is unavailable in isolated Web plugin runtime')); },
    readFile: function(){ return Promise.reject(new Error('File is unavailable in isolated Web plugin runtime')); },
    readdir: function(){ return Promise.resolve([]); },
    writeFile: function(){ return Promise.reject(new Error('File write requires an ATools permission bridge')); },
    mkdir: function(){ return Promise.reject(new Error('File write requires an ATools permission bridge')); }
  };
  var _compatFs = {
    promises: _compatFsPromises,
    existsSync: function(){ return false; },
    readFileSync: _compatUnsupported('fs.readFileSync'),
    writeFileSync: _compatUnsupported('fs.writeFileSync'),
    appendFileSync: _compatUnsupported('fs.appendFileSync'),
    readdirSync: function(){ return []; },
    mkdirSync: _compatUnsupported('fs.mkdirSync'),
    lstatSync: _compatUnsupported('fs.lstatSync'),
    statSync: _compatUnsupported('fs.statSync')
  };
  var _compatOs = {
    homedir: function(){ return _atoolsPluginPath || '/'; },
    tmpdir: function(){ return '/tmp'; },
    platform: function(){ return 'darwin'; },
    release: function(){ return ''; },
    arch: function(){ return 'arm64'; }
  };
  var _compatChildProcess = {
    exec: _compatUnsupported('child_process.exec'),
    execFile: _compatUnsupported('child_process.execFile'),
    spawn: _compatUnsupported('child_process.spawn')
  };
  var _compatElectron = {
    ipcRenderer: _ipcRenderer
  };
  if (!window.process) {
    var _processListeners = {};
    window.process = {
      platform: 'darwin', arch: 'arm64', env: {}, versions: { node: 'compat' },
      on: function(event, listener) { (_processListeners[event] || (_processListeners[event] = [])).push(listener); return this; },
      once: function(event, listener) { if (event === 'loaded' && typeof listener === 'function') queueMicrotask(listener); else this.on(event, listener); return this; },
      off: function(event, listener) { _processListeners[event] = (_processListeners[event] || []).filter(function(item) { return item !== listener; }); return this; },
      removeListener: function(event, listener) { return this.off(event, listener); },
      nextTick: function(callback) { return queueMicrotask(callback); }
    };
  }
  if (typeof window.global === 'undefined') window.global = window;
  if (typeof window.__dirname === 'undefined') window.__dirname = _atoolsPluginPath;
  if (typeof window.__filename === 'undefined') window.__filename = _compatPath.join(_atoolsPluginPath, 'preload.js');
  if (typeof window.require !== 'function') {
    window.require = function(name) {
      var moduleName = String(name || '').replace(/^node:/, '');
      if (moduleName === 'electron') return _compatElectron;
      if (moduleName === 'buffer') return { Buffer: window.Buffer, SlowBuffer: window.Buffer };
      if (moduleName === 'path') return _compatPath;
      if (moduleName === 'fs') return _compatFs;
      if (moduleName === 'fs/promises') return _compatFsPromises;
      if (moduleName === 'os') return _compatOs;
      if (moduleName === 'child_process') return _compatChildProcess;
      if (moduleName === 'url') return { URL: window.URL, URLSearchParams: window.URLSearchParams };
      if (moduleName === 'adm-zip') return function(){ throw new Error('ZIP access requires a native sidecar'); };
      if (moduleName === 'crypto' || moduleName === 'http' || moduleName === 'https' || moduleName === 'net' || moduleName === 'tls' || moduleName === 'zlib') {
        return new Proxy({}, { get: function(_target, property) { return _compatUnsupported(moduleName + '.' + String(property)); } });
      }
      if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
        throw new Error('ERR_ATOOLS_PRELOAD_MODULE_NOT_FOUND: ' + moduleName);
      }
      throw new Error('Cannot find module ' + moduleName);
    };
  }
  if (typeof window.Buffer === 'undefined') window.Buffer = (__ATOOLS_BUFFER_FACTORY__)();
  if (typeof window.setImmediate !== 'function') window.setImmediate = function(callback) { return setTimeout(callback, 0); };
  if (typeof window.clearImmediate !== 'function') window.clearImmediate = function(id) { clearTimeout(id); };
  (__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__)(window, __ATOOLS_WORKER_SCOPE__);
  function _createBrowserWindowHandle(result) {
`;
export default part;
