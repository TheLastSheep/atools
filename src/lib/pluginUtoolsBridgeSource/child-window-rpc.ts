const part = `  function _hostedBrowserWindowRpcError(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function _hostedBrowserWindowRpcNumber(value, fallback) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : (fallback || 0);
  }
  function _hostedBrowserWindowRpcModifiers(inputEvent) {
    var modifiers = Array.isArray(inputEvent.modifiers)
      ? inputEvent.modifiers.map(function(value) { return String(value).toLowerCase(); })
      : [];
    return {
      altKey: inputEvent.altKey === true || modifiers.indexOf('alt') >= 0,
      ctrlKey: inputEvent.ctrlKey === true || modifiers.indexOf('control') >= 0 || modifiers.indexOf('ctrl') >= 0,
      metaKey: inputEvent.metaKey === true || modifiers.indexOf('meta') >= 0 || modifiers.indexOf('command') >= 0 || modifiers.indexOf('cmd') >= 0,
      shiftKey: inputEvent.shiftKey === true || modifiers.indexOf('shift') >= 0
    };
  }
  function _hostedBrowserWindowRpcSendInputEvent(args) {
    var inputEvent = args && args.inputEvent;
    if (!inputEvent || typeof inputEvent !== 'object' || Array.isArray(inputEvent)) {
      throw new Error('webContents.sendInputEvent requires an input event object');
    }
    var rawType = String(inputEvent.type || '').trim().toLowerCase();
    if (!rawType) throw new Error('webContents.sendInputEvent requires an input event type');
    var target = document.activeElement || document.body || document;
    var modifiers = _hostedBrowserWindowRpcModifiers(inputEvent);
    var keyboardType = rawType === 'rawkeydown' || rawType === 'keydown'
      ? 'keydown'
      : (rawType === 'keyup' ? 'keyup' : (rawType === 'char' ? 'keypress' : ''));
    if (keyboardType) {
      var key = String(inputEvent.key || inputEvent.keyCode || inputEvent.code || '');
      var code = String(inputEvent.code || inputEvent.keyCode || inputEvent.key || '');
      target.dispatchEvent(new window.KeyboardEvent(keyboardType, {
        bubbles: true,
        cancelable: true,
        key: key,
        code: code,
        repeat: inputEvent.repeat === true || inputEvent.isAutoRepeat === true,
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    var mouseTypes = {
      mousedown: 'mousedown',
      mouseup: 'mouseup',
      mousemove: 'mousemove',
      mouseenter: 'mouseenter',
      mouseleave: 'mouseleave',
      contextmenu: 'contextmenu'
    };
    var mouseType = mouseTypes[rawType];
    var x = _hostedBrowserWindowRpcNumber(inputEvent.x != null ? inputEvent.x : inputEvent.clientX, 0);
    var y = _hostedBrowserWindowRpcNumber(inputEvent.y != null ? inputEvent.y : inputEvent.clientY, 0);
    var pointTarget = document.elementFromPoint && document.elementFromPoint(x, y) || target;
    if (mouseType) {
      var buttonName = String(inputEvent.button == null ? 'left' : inputEvent.button).toLowerCase();
      var button = buttonName === 'middle' ? 1 : (buttonName === 'right' ? 2 : (buttonName === 'left' ? 0 : _hostedBrowserWindowRpcNumber(inputEvent.button, 0)));
      pointTarget.dispatchEvent(new window.MouseEvent(mouseType, {
        bubbles: mouseType !== 'mouseenter' && mouseType !== 'mouseleave',
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: _hostedBrowserWindowRpcNumber(inputEvent.globalX != null ? inputEvent.globalX : inputEvent.screenX, x),
        screenY: _hostedBrowserWindowRpcNumber(inputEvent.globalY != null ? inputEvent.globalY : inputEvent.screenY, y),
        button: button,
        buttons: _hostedBrowserWindowRpcNumber(inputEvent.buttons, mouseType === 'mouseup' || mouseType === 'mouseleave' ? 0 : (button === 1 ? 4 : (button === 2 ? 2 : 1))),
        detail: _hostedBrowserWindowRpcNumber(inputEvent.clickCount, 0),
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    if (rawType === 'mousewheel') {
      pointTarget.dispatchEvent(new window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaX: _hostedBrowserWindowRpcNumber(inputEvent.deltaX != null ? inputEvent.deltaX : inputEvent.wheelDeltaX, 0),
        deltaY: _hostedBrowserWindowRpcNumber(inputEvent.deltaY != null ? inputEvent.deltaY : inputEvent.wheelDeltaY, 0),
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
        shiftKey: modifiers.shiftKey
      }));
      return undefined;
    }
    throw new Error('Unsupported webContents.sendInputEvent type: ' + String(inputEvent.type || ''));
  }
  function _hostedBrowserWindowRpcFind(args) {
    var text = String(args && args.text || '');
    if (!text) throw new Error('webContents.findInPage requires non-empty text');
    var matchCase = args && args.matchCase === true;
    var needle = matchCase ? text : text.toLowerCase();
    var rawHaystack = document.body && document.body.innerText || document.documentElement && document.documentElement.textContent || '';
    var haystack = matchCase ? rawHaystack : rawHaystack.toLowerCase();
    var index = 0;
    var matches = 0;
    while (needle && index <= haystack.length) {
      var foundIndex = haystack.indexOf(needle, index);
      if (foundIndex < 0) break;
      matches += 1;
      index = foundIndex + needle.length;
    }
    var rect = matches > 0 && document.body && document.body.getBoundingClientRect
      ? document.body.getBoundingClientRect()
      : null;
    var forward = !args || args.forward !== false;
    return {
      requestId: Number(args && args.requestId || 0),
      activeMatchOrdinal: matches <= 0 ? 0 : (forward ? 1 : matches),
      matches: matches,
      selectionArea: {
        x: Math.max(0, Math.round(rect && rect.left || 0)),
        y: Math.max(0, Math.round(rect && rect.top || 0)),
        width: Math.max(0, Math.round(rect && rect.width || 0)),
        height: Math.max(0, Math.round(rect && rect.height || 0))
      },
      finalUpdate: true
    };
  }
  function _hostedBrowserWindowRpcDispatch(method, args) {
    if (!_hostedBrowserWindowRpcMethods[method]) {
      throw new Error('Unsupported hosted BrowserWindow RPC method: ' + String(method || '(empty)'));
    }
    if (method === 'describe') {
      return {
        title: String(document.title || ''),
        readyState: String(document.readyState || ''),
        text: String(document.body && document.body.innerText || document.documentElement && document.documentElement.textContent || '')
      };
    }
    if (method === 'executeJavaScript') {
      return (0, eval)(String(args && args.code || ''));
    }
    if (method === 'sendInputEvent') return _hostedBrowserWindowRpcSendInputEvent(args || {});
    if (method === 'insertCSS') {
      var cssKey = String(args && args.key || '');
      var css = String(args && args.css || '');
      if (!cssKey || !css) throw new Error('webContents.insertCSS requires key and CSS text');
      var style = document.createElement('style');
      style.setAttribute('data-atools-browser-window-css-key', cssKey);
      style.setAttribute('data-atools-browser-window-css-origin', args && args.cssOrigin === 'user' ? 'user' : 'author');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      return cssKey;
    }
    if (method === 'removeInsertedCSS') {
      var removeKey = String(args && args.key || '');
      var styles = document.querySelectorAll('style[data-atools-browser-window-css-key]');
      Array.prototype.some.call(styles, function(styleNode) {
        if (styleNode.getAttribute('data-atools-browser-window-css-key') !== removeKey) return false;
        styleNode.remove();
        return true;
      });
      return undefined;
    }
    if (method === 'findInPage') return _hostedBrowserWindowRpcFind(args || {});
    if (method === 'stopFindInPage') {
      var stopAction = String(args && args.action || 'clearSelection');
      if (stopAction !== 'keepSelection' && stopAction !== 'activateSelection') {
        var selection = window.getSelection && window.getSelection();
        if (selection) selection.removeAllRanges();
      }
      return undefined;
    }
    throw new Error('Unsupported hosted BrowserWindow RPC method: ' + String(method || '(empty)'));
  }
  function _acceptHostedBrowserWindowRpc(event) {
    var data = event && event.data;
    if (!data || data.__atools_hosted_browser_window_rpc_init__ !== true) return false;
    if ((_atoolsWindowType || 'main') !== 'browserWindow') return true;
    if (event.source !== window.parent) return true;
    var generation = Number(data.generation);
    var port = event.ports && event.ports[0];
    if (!Number.isSafeInteger(generation) || generation <= _hostedBrowserWindowRpcGeneration || !port) return true;
    if (_hostedBrowserWindowRpcPort && typeof _hostedBrowserWindowRpcPort.close === 'function') {
      _hostedBrowserWindowRpcPort.close();
    }
    _hostedBrowserWindowRpcGeneration = generation;
    _hostedBrowserWindowRpcPort = port;
    port.onmessage = function(portEvent) {
      var request = portEvent && portEvent.data;
      if (!request || request.__atools_hosted_browser_window_rpc_request__ !== true) return;
      if (request.generation !== _hostedBrowserWindowRpcGeneration) return;
      var reqId = Number(request.reqId);
      if (!Number.isSafeInteger(reqId) || reqId <= 0) return;
      Promise.resolve().then(function() {
        return _hostedBrowserWindowRpcDispatch(String(request.method || ''), request.args || {});
      }).then(function(result) {
        try {
          port.postMessage({
            __atools_hosted_browser_window_rpc_response__: true,
            generation: _hostedBrowserWindowRpcGeneration,
            reqId: reqId,
            result: result
          });
        } catch (cloneError) {
          port.postMessage({
            __atools_hosted_browser_window_rpc_response__: true,
            generation: _hostedBrowserWindowRpcGeneration,
            reqId: reqId,
            error: _hostedBrowserWindowRpcError(cloneError)
          });
        }
      }, function(error) {
        port.postMessage({
          __atools_hosted_browser_window_rpc_response__: true,
          generation: _hostedBrowserWindowRpcGeneration,
          reqId: reqId,
          error: _hostedBrowserWindowRpcError(error)
        });
      });
    };
    if (typeof port.start === 'function') port.start();
    port.postMessage({
      __atools_hosted_browser_window_rpc_ready__: true,
      generation: generation,
      documentNonce: _hostedIpcBridge.documentNonce
    });
    return true;
  }

  var _lastPluginActivationId = 0;
  var _pluginLifecycleTerminated = false;
  window.addEventListener('message', function(e) {
    if (_acceptHostedBrowserWindowRpc(e)) return;
    if (e.data && e.data.__atools_permission_response__) {
      _resolvePluginPermissionResponse(e.data);
    }
    if (e.data && e.data.__atools_lifecycle__) {
      var lifecycleEvent = String(e.data.event || '');
      if (lifecycleEvent === 'plugin-out') {
        _pluginLifecycleTerminated = true;
        _subInputBridge.dispose();
        window.dispatchEvent(new CustomEvent('atools-plugin-out', { detail: { isKill: e.data.isKill === true } }));
      } else if (lifecycleEvent === 'plugin-hide') {
        if (!_pluginLifecycleTerminated) window.dispatchEvent(new Event('atools-plugin-hidden'));
      } else if (lifecycleEvent === 'plugin-enter') {
        var activationId = e.data.activationId;
        if (!_pluginLifecycleTerminated && Number.isSafeInteger(activationId) && activationId > _lastPluginActivationId
          && e.data.action && typeof e.data.action === 'object' && !Array.isArray(e.data.action)) {
          _lastPluginActivationId = activationId;
          if (_pluginFeatureExports && typeof _pluginFeatureExports.reenter === 'function') {
            _pluginFeatureExports.reenter(_pluginEnterAction(e.data.action), activationId);
          }
        }
      } else if (lifecycleEvent === 'plugin-detach') {
        window.dispatchEvent(new CustomEvent('atools-plugin-detach'));
      }
    }
    if (e.data && e.data.__atools_native_response__) {
      var p = _nativePending[e.data.reqId];
      if (p) {
        if (e.data.error) p.reject(new Error(String(e.data.error)));
        else p.resolve(e.data.result);
        delete _nativePending[e.data.reqId];
      }
    }
    if (e.data && e.data.__atools_resource_response__) {
      var resource = _resourcePending[e.data.reqId];
      if (resource) {
        if (e.data.error) resource.reject(new Error(String(e.data.error)));
        else resource.resolve(e.data.url);
        delete _resourcePending[e.data.reqId];
      }
    }
    if (e.data && e.data.__atools_browser_window_parent_message__) {
      var channel = String(e.data.channel || '');
      var args = Array.isArray(e.data.args) ? e.data.args : [];
      _emitChildIpc(channel, args);
    }
    if (e.source === window.parent && e.data && e.data.__atools_browser_window_geometry__) {
      var geometryHandle = _browserWindowHandles[String(e.data.windowId || '')];
      if (geometryHandle) geometryHandle.__atoolsApplyGeometry(e.data.geometrySnapshot);
    }
    if (e.source === window.parent && e.data && e.data.__atools_browser_window_event__) {
      var dispatcher = _browserWindowEventDispatchers[e.data.windowId];
      if (typeof dispatcher === 'function') {
        var eventName = String(e.data.event || '');
        var eventArgs = Array.isArray(e.data.args) ? e.data.args : [];
        var eventTarget = String(e.data.target || '');
        dispatcher(eventName, eventArgs, eventTarget, e.data.geometrySnapshot);
      }
    }
    if (e.data && e.data.__atools_browser_window_ipc__) {
      var targetWindowId = String(e.data.windowId || '');
      if ((_atoolsWindowType || 'main') === 'browserWindow' && targetWindowId === (_atoolsBrowserWindowId || '')) {
        var ipcChannel = String(e.data.channel || '');
        var ipcArgs = Array.isArray(e.data.args) ? e.data.args : [];
        _emitChildIpc(ipcChannel, ipcArgs);
      }
    }
  });

  function _nativeCall(method, args) {
`;
export default part;
