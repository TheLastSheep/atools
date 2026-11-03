const part = `
<script>
(function() {
  // The sandbox never receives or discovers Tauri internals. Every command is
  // mediated by the host-side source registry and deny-by-default policy.
  var _reqId = 0;
  var _pending = {};
  var _atoolsPluginPath = typeof __PLUGIN_PATH__ === 'undefined' ? '' : __PLUGIN_PATH__;
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__ipc_response__) {
      var p = _pending[e.data.reqId];
      if (p) {
        if (e.data.error) p.reject(new Error(String(e.data.error)));
        else p.resolve(e.data.result);
        delete _pending[e.data.reqId];
      }
    }
  });
  var _invoke = function(cmd, args) {
    return new Promise(function(resolve, reject) {
      var id = ++_reqId;
      _pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ __ipc_call__: true, reqId: id, cmd: cmd, args: args || {} }, '*');
    });
  };

  var _atoolsPluginPermissions = null;
  var _atoolsDeclaredProviders = null;
  var _atoolsRuntimeGrantedPermissions = {};
  var _permissionReqId = 0;
  var _permissionPending = {};
  function _pluginPermissionGroup(permission) {
    var value = String(permission || '').trim();
    if (!value) return '';
    var dot = value.indexOf('.');
    return dot > 0 ? value.slice(0, dot) : value;
  }
  function _pluginPermissionAllowed(permission) {
    var value = String(permission || '').trim();
    if (!value) return true;
    if (_atoolsRuntimeGrantedPermissions[value] === true) return true;
    if (!Array.isArray(_atoolsPluginPermissions)) return true;
    var group = _pluginPermissionGroup(value);
    return _atoolsPluginPermissions.some(function(item) {
      var allowed = String(item || '').trim();
      if (!allowed) return false;
      if (allowed === '*' || allowed === value || allowed === group) return true;
      if (allowed.endsWith('.*') && value.indexOf(allowed.slice(0, -1)) === 0) return true;
      return false;
    });
  }
  function _requirePluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value || _pluginPermissionAllowed(value)) return true;
    throw new Error('Plugin permission denied: ' + value);
  }
  function _requestPluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value || _pluginPermissionAllowed(value)) return Promise.resolve(true);
    return new Promise(function(resolve, reject) {
      var id = ++_permissionReqId;
      _permissionPending[id] = { permission: value, resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_permission_request__: true,
        reqId: id,
        permission: value,
        pluginId: __PLUGIN_ID__,
        featureCode: __FEATURE_CODE__
      }, '*');
    });
  }
  function _permissionPromise(permission, executor) {
    try {
      var value = String(permission || '').trim();
      if (!value || _pluginPermissionAllowed(value)) {
        return executor();
      }
      return _requestPluginPermission(value).then(function() {
        return executor();
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }
  function _rejectPluginPermission(permission) {
    var value = String(permission || '').trim();
    if (!value) value = 'unknown';
    return new Error('Plugin permission denied: ' + value);
  }
  function _resolvePluginPermissionResponse(data) {
    var reqId = data && data.reqId;
    var pending = _permissionPending[reqId];
    if (!pending) return;
    delete _permissionPending[reqId];
    if (data.allowed === true) {
      _atoolsRuntimeGrantedPermissions[pending.permission] = true;
      pending.resolve(true);
    } else {
      pending.reject(_rejectPluginPermission(pending.permission));
    }
  }
  function _invokePermissionForCommand(cmd, args) {
    switch (String(cmd || '')) {
      case 'put_plugin_data':
      case 'put_plugin_data_bulk':
      case 'get_plugin_data':
      case 'get_plugin_data_item':
      case 'remove_plugin_data':
        return 'data';
      case 'copy_text':
        return 'clipboard.write';
      case 'shell_open': {
        var target = String(args && args.url || '').trim();
        if (/^file:/i.test(target) || !/^[a-z][a-z\\d+.-]*:/i.test(target)) return 'shell.openPath';
        return 'shell.openExternal';
      }
      case 'system_get_path':
        return 'system.path';
      case 'show_notification':
        return 'notification';
      default:
        return null;
    }
  }
  function _nativePermissionForMethod(method) {
    switch (String(method || '')) {
      case 'showOpenDialog':
        return 'dialog.open';
      case 'showSaveDialog':
        return 'dialog.save';
      case 'copyImage':
      case 'copyFile':
      case 'hideMainWindowPasteText':
      case 'hideMainWindowPasteImage':
      case 'hideMainWindowPasteFile':
        return 'clipboard.write';
      case 'getCopyedFiles':
      case 'readClipboardText':
      case 'listClipboardHistory':
        return 'clipboard.read';
      case 'getNativeIpSnapshot':
        return 'network.read';
      case 'performNativeHttpRequest':
        return 'network.http';
      case 'translateNativeText':
        return 'translation.request';
      case 'providersGetProviders':
      case 'providersGetDefault':
      case 'providersSetDefault':
      case 'providersInvoke':
        return 'provider';
      case 'readNativeHosts':
        return 'system.hosts.read';
      case 'writeNativeHosts':
        return 'system.hosts.write';
      case 'listNativeTodos':
        return 'todo.read';
      case 'saveNativeTodo':
        return 'todo.write';
      case 'deleteNativeTodo':
        return 'todo.delete';
      case 'calculateNativeSheet':
        return 'calculation.write';
      case 'listNativeCalculationHistory':
        return 'calculation.read';
      case 'clearNativeCalculationHistory':
        return 'calculation.delete';
      case 'nativeCodecTransform':
        return 'codec.transform';
      case 'nativeTimeSnapshot':
        return 'time.read';
      case 'convertNativeTime':
        return 'time.convert';
      case 'generateNativeQr':
        return 'qr.generate';
      case 'nativeJsonTransform':
        return 'json.transform';
      case 'convertNativeColor':
        return 'color.convert';
      case 'listNativeProcesses':
        return 'process.read';
      case 'terminateNativeProcess':
        return 'process.terminate';
      case 'shellOpenPath':
        return 'shell.openPath';
      case 'shellOpenExternal':
        return 'shell.openExternal';
      case 'shellShowItemInFolder':
        return 'shell.showItemInFolder';
      case 'shellTrashItem':
        return 'shell.trashItem';
      case 'shellBeep':
        return 'shell.beep';
      case 'screenCapture':
        return 'screen.capture';
      case 'screenColorPick':
        return 'screen.colorPick';
      case 'desktopCaptureSources':
        return 'screen.desktopCaptureSources';
      case 'readCurrentBrowserUrl':
        return 'context.browser';
      case 'readCurrentFolderPath':
        return 'context.finder';
      case 'simulateKeyboardTap':
      case 'hideMainWindowTypeString':
        return 'input.keyboard';
      case 'startDrag':
        return 'file.drag';
      case 'createBrowserWindow':
      case 'sendToParent':
      case 'sendTo':
      case 'browserWindowAction':
        return 'browserWindow';
      case 'redirect':
      case 'redirectHotKeySetting':
      case 'redirectAiModelsSetting':
        return 'settings.redirect';
      default:
        return null;
    }
  }
  var _rawInvokeFn = _invoke;
  var _invokeFn = function(cmd, args) {
    var permission = _invokePermissionForCommand(cmd, args);
    if (!permission) return Promise.reject(new Error('Unsupported plugin invoke command: ' + String(cmd || '(empty)')));
    return _permissionPromise(permission, function() {
      return _rawInvokeFn(cmd, args);
    });
  };
  var _nativeReqId = 0;
  var _nativePending = {};
  var _resourceReqId = 0;
  var _resourcePending = {};
  var _atoolsWindowType = 'main';
  var _atoolsWindowHostKind = 'hosted';
  var _atoolsBrowserWindowId = '';
  var _atoolsBrowserWindowGeometry = null;
  var _browserWindowEventDispatchers = {};
  var _browserWindowHandles = {};
  var _browserWindowBridge = null;
  var _hostedBrowserWindowRpcPort = null;
  var _hostedBrowserWindowRpcGeneration = 0;
  var _hostedBrowserWindowRpcMethods = {
    describe: true,
    executeJavaScript: true,
    sendInputEvent: true,
    insertCSS: true,
    removeInsertedCSS: true,
    findInPage: true,
    stopFindInPage: true
  };

`;
export default part;
