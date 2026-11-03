const part = `      if (result instanceof ArrayBuffer) return new Uint8Array(result);
      if (typeof Uint8Array === 'function' && result instanceof Uint8Array) return result;
      var record = result && typeof result === 'object' ? result : {};
      var data = Array.isArray(record.data) ? record.data : Array.isArray(record.bytes) ? record.bytes : null;
      if (data) return typeof Uint8Array === 'function' ? new Uint8Array(data) : data.slice();
      var base64 = typeof record.base64 === 'string'
        ? record.base64
        : typeof record.dataUrl === 'string'
          ? (record.dataUrl.match(/^data:[^;]+;base64,(.*)$/) || [])[1]
          : '';
      if (base64 && typeof atob === 'function') {
        var binary = atob(base64);
        if (typeof Uint8Array !== 'function') return binary;
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }
      return result;
    }
    function hostedNativeImageFromResult(result) {
      var record = result && typeof result === 'object' ? result : {};
      var dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
      var width = Number(record.width || (record.size && record.size.width) || 0);
      var height = Number(record.height || (record.size && record.size.height) || 0);
      var size = {
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
      };
      return {
        toDataURL: function() { return dataUrl; },
        toPNG: function() { return hostedWebContentsBytes(record); },
        getSize: function() { return { width: size.width, height: size.height }; },
        getAspectRatio: function() { return size.height > 0 ? size.width / size.height : 0; },
        isEmpty: function() { return !dataUrl && !record.base64 && !record.data && !record.bytes; },
      };
    }
    function webContentsCapturePage(rect, opts) {
      var payload = [];
      if (arguments.length > 0) payload.push(rect || {});
      if (arguments.length > 1) payload.push(opts || {});
      return _browserWindowAction.apply(null, [id, 'webContents.capturePage'].concat(payload)).then(hostedNativeImageFromResult);
    }
    function webContentsPrint(options, callback) {
      var printOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      var done = typeof options === 'function' ? options : typeof callback === 'function' ? callback : null;
      _browserWindowAction(id, 'webContents.print', printOptions).then(function(result) {
        if (!done) return;
        var record = result && typeof result === 'object' ? result : {};
        var success = record.success === true;
        var failureReason = typeof record.failureReason === 'string' ? record.failureReason : '';
        done(success, failureReason);
      }).catch(function(err) {
        var message = err && err.message ? err.message : String(err);
        if (done) done(false, message);
        else console.error('[browserWindow webContents.print]', err);
      });
      return undefined;
    }
    function webContentsPrintToPDF(options) {
      var printOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return _browserWindowAction(id, 'webContents.printToPDF', printOptions).then(hostedWebContentsBytes);
    }
    function webContentsSavePage(fullPath, saveType) {
      return _browserWindowAction(
        id,
        'webContents.savePage',
        String(fullPath == null ? '' : fullPath),
        String(saveType == null ? '' : saveType)
      ).then(function() {
        return undefined;
      });
    }
    var navigationHistory = {
      canGoBack: function() { return webContentsHistoryIndex > 0; },
      canGoForward: function() { return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory.length - 1; },
      goBack: function() { return navigationHistoryAction('webContents.navigationHistory.goBack'); },
      goForward: function() { return navigationHistoryAction('webContents.navigationHistory.goForward'); },
      goToIndex: function(index) { return navigationHistoryAction('webContents.navigationHistory.goToIndex', navigationHistoryIndex(index)); },
      canGoToOffset: function(offset) { return navigationHistoryCanGoToOffset(offset); },
      goToOffset: function(offset) { return navigationHistoryAction('webContents.navigationHistory.goToOffset', navigationHistoryOffset(offset)); },
      clear: function() { return navigationHistoryClear(); },
    };
    var webContents = {
      id: record.webContentsId,
      navigationHistory: navigationHistory,
      getURL: function() { return webContentsUrl; },
      getTitle: function() { return webContentsTitle; },
      isLoading: function() { return webContentsLoading; },
      isLoadingMainFrame: function() { return webContentsLoading; },
      isWaitingForResponse: function() { return webContentsLoading; },
      canGoBack: function() { return webContentsHistoryIndex > 0; },
      canGoForward: function() { return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory.length - 1; },
      loadURL: function(url, options) { return webContentsNavigationAction('webContents.loadURL', String(url || ''), options || {}); },
      reload: function() { return webContentsNavigationAction('webContents.reload'); },
      goBack: function() { return webContentsNavigationAction('webContents.goBack'); },
      goForward: function() { return webContentsNavigationAction('webContents.goForward'); },
      reloadIgnoringCache: function() { return webContentsNavigationAction('webContents.reloadIgnoringCache'); },
      stop: function() { return webContentsStop(); },
      isDestroyed: function() { return destroyed; },
      getType: function() { return 'window'; },
      isCrashed: function() { return webContentsCrashed; },
      forcefullyCrashRenderer: function() { return webContentsForcefullyCrashRenderer(); },
      focus: function() { return webContentsFocus(); },
      isFocused: function() { return webContentsFocused; },
      getOwnerBrowserWindow: function() { return handle; },
      getMediaSourceId: function() {
        if (nativeHost) return nativeIdentifierUnsupported('webContents.getMediaSourceId');
        return webContentsMediaSourceId;
      },
      isBeingCaptured: function() { return webContentsBeingCaptured; },
      setIgnoreMenuShortcuts: function(ignore) { return webContentsSetIgnoreMenuShortcuts(ignore); },
      openDevTools: function(options) { return webContentsDevToolsAction('webContents.openDevTools', options || {}); },
      closeDevTools: function() { return webContentsDevToolsAction('webContents.closeDevTools'); },
      toggleDevTools: function() { return webContentsDevToolsAction('webContents.toggleDevTools'); },
      isDevToolsOpened: function() { return webContentsDevToolsOpened; },
      isDevToolsFocused: function() { return webContentsDevToolsOpened && webContentsDevToolsFocused; },
      inspectElement: function(x, y) { return webContentsInspectElement(x, y); },
      capturePage: function(rect, opts) { return webContentsCapturePage.apply(null, arguments); },
      print: function(options, callback) { return webContentsPrint(options, callback); },
      printToPDF: function(options) { return webContentsPrintToPDF(options); },
      savePage: function(fullPath, saveType) { return webContentsSavePage(fullPath, saveType); },
      getUserAgent: function() { return webContentsUserAgent; },
      setUserAgent: function(userAgent) { return webContentsSetUserAgent(userAgent); },
      getFrameRate: function() { return webContentsFrameRate; },
      setFrameRate: function(frameRate) { return webContentsSetFrameRate(frameRate); },
      getBackgroundThrottling: function() { return webContentsBackgroundThrottling; },
      setBackgroundThrottling: function(allowed) { return webContentsSetBackgroundThrottling(allowed); },
      getProcessId: function() {
        if (nativeHost) return nativeIdentifierUnsupported('webContents.getProcessId');
        return webContentsProcessId;
      },
      getOSProcessId: function() {
        if (nativeHost) return nativeIdentifierUnsupported('webContents.getOSProcessId');
        return webContentsOSProcessId;
      },
      centerSelection: function() { return webContentsEditAction('webContents.centerSelection'); },
      scrollToTop: function() { return webContentsEditAction('webContents.scrollToTop'); },
      scrollToBottom: function() { return webContentsEditAction('webContents.scrollToBottom'); },
      adjustSelection: function(options) {
        var selectionOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        return webContentsEditAction('webContents.adjustSelection', {
          start: Number(selectionOptions.start || 0),
          end: Number(selectionOptions.end || 0),
        });
      },
      insertText: function(text) { return webContentsInsertText(text); },
      undo: function() { return webContentsEditAction('webContents.undo'); },
      redo: function() { return webContentsEditAction('webContents.redo'); },
      cut: function() { return webContentsEditAction('webContents.cut'); },
      copy: function() { return webContentsEditAction('webContents.copy'); },
      paste: function() { return webContentsEditAction('webContents.paste'); },
      pasteAndMatchStyle: function() { return webContentsEditAction('webContents.pasteAndMatchStyle'); },
      delete: function() { return webContentsEditAction('webContents.delete'); },
      selectAll: function() { return webContentsEditAction('webContents.selectAll'); },
      unselect: function() { return webContentsEditAction('webContents.unselect'); },
      replace: function(text) { return webContentsEditAction('webContents.replace', String(text == null ? '' : text)); },
      replaceMisspelling: function(text) { return webContentsEditAction('webContents.replaceMisspelling', String(text == null ? '' : text)); },
      setZoomFactor: function(factor) { return webContentsSetZoomFactor(factor); },
      getZoomFactor: function() { return webContentsZoomFactor; },
      setZoomLevel: function(level) { return webContentsSetZoomLevel(level); },
      getZoomLevel: function() { return webContentsZoomLevel; },
      setVisualZoomLevelLimits: function(minimumLevel, maximumLevel) {
        return _browserWindowAction(id, 'webContents.setVisualZoomLevelLimits', Number(minimumLevel), Number(maximumLevel)).then(function(result) {
          syncWebContentsZoomState(result);
          return undefined;
        });
      },
      setAudioMuted: function(muted) { return webContentsSetAudioMuted(muted); },
      isAudioMuted: function() { return webContentsAudioMuted; },
      isCurrentlyAudible: function() { return webContentsCurrentlyAudible; },
      send: function(channel) {
        var payload = Array.prototype.slice.call(arguments);
        payload[0] = String(channel || '');
        return _browserWindowAction.apply(null, [id, 'webContents.send'].concat(payload));
      },
      executeJavaScript: function(code, userGesture) {
        return _browserWindowAction(id, 'webContents.executeJavaScript', String(code == null ? '' : code), userGesture === true);
      },
      sendInputEvent: function(inputEvent) {
        return _browserWindowAction(id, 'webContents.sendInputEvent', inputEvent || {});
      },
      insertCSS: function(css, options) {
        return _browserWindowAction(id, 'webContents.insertCSS', String(css == null ? '' : css), options || {});
      },
      removeInsertedCSS: function(key) {
        return _browserWindowAction(id, 'webContents.removeInsertedCSS', String(key || ''));
      },
      findInPage: function(text, options) {
        var requestId = ++webContentsFindReqId;
        _browserWindowAction(id, 'webContents.findInPage', String(text == null ? '' : text), options || {}, requestId).catch(function(err) {
          console.error('[browserWindow webContents.findInPage]', err);
        });
        return requestId;
      },
      stopFindInPage: function(action) {
        _browserWindowAction(id, 'webContents.stopFindInPage', String(action || 'clearSelection')).catch(function(err) {
          console.error('[browserWindow webContents.stopFindInPage]', err);
        });
        return undefined;
      },
      on: function(name, listener) { return addWebContentsListener(name, listener, false); },
      addListener: function(name, listener) { return addWebContentsListener(name, listener, false); },
      once: function(name, listener) { return addWebContentsListener(name, listener, true); },
      off: function(name, listener) { return removeWebContentsListener(name, listener); },
      removeListener: function(name, listener) { return removeWebContentsListener(name, listener); },
      removeAllListeners: function(name) { return removeAllWebContentsListeners(name); }
    };
    if (id) {
      _browserWindowEventDispatchers[id] = function(name, args, target, geometrySnapshot) {
        if (target !== 'webContents' && geometry.hasState() && !geometry.acceptEvent(geometrySnapshot)) return;
        geometry.apply(geometrySnapshot);
        if (target === 'webContents') {
          syncWebContentsDevToolsEvent(name, args);
          syncWebContentsAudioEvent(name, args);
          syncWebContentsCrashEvent(name);
          emitWebContentsEvent(name, args);
          return;
        }
        if (name === 'closed') {
          geometry.close();
          destroyed = true;
          delete _browserWindowHandles[id];
        }
        syncWebContentsWindowEvent(name, args);
        emitEvent(name, args);
        if (name === 'closed') {
          delete _browserWindowEventDispatchers[id];
        }
      };
    }
    var handle = {
      id: id,
      type: 'browserWindow',
      windowType: 'browserWindow',
      url: String(record.url || ''),
      title: String(record.title || ''),
      show: function() { return _browserWindowAction(id, 'show'); },
      hide: function() { return _browserWindowAction(id, 'hide'); },
      focus: function() { return browserWindowFocusAction('focus'); },
      isVisible: function() { return _browserWindowAction(id, 'isVisible'); },
      isFocused: function() { return _browserWindowAction(id, 'isFocused'); },
      showInactive: function() { return browserWindowFocusAction('showInactive'); },
      blur: function() { return browserWindowFocusAction('blur'); },
      getTitle: function() { return _browserWindowAction(id, 'getTitle'); },
      setTitle: function(title) { return _browserWindowAction(id, 'setTitle', String(title || '')); },
      getURL: function() { return _browserWindowAction(id, 'getURL'); },
      loadURL: function(url) { return webContentsNavigationAction('loadURL', String(url || '')); },
      reload: function() { return webContentsNavigationAction('reload'); },
      minimize: function() { return browserWindowShapeAction('minimize'); },
      isMinimized: function() { return _browserWindowAction(id, 'isMinimized'); },
      restore: function() { return browserWindowShapeAction('restore'); },
      maximize: function() { return browserWindowShapeAction('maximize'); },
      unmaximize: function() { return browserWindowShapeAction('unmaximize'); },
      isMaximized: function() { return _browserWindowAction(id, 'isMaximized'); },
      isAlwaysOnTop: function() { return _browserWindowAction(id, 'isAlwaysOnTop'); },
      setAlwaysOnTop: function(flag) { return _browserWindowAction(id, 'setAlwaysOnTop', flag === true); },
      getBackgroundColor: function() { return browserWindowBackgroundColor; },
      setBackgroundColor: function(backgroundColor) { return browserWindowSetBackgroundColor(backgroundColor); },
      setAutoHideMenuBar: function(hide) { return browserWindowSetAutoHideMenuBar(hide); },
      isMenuBarAutoHide: function() { return browserWindowMenuBarAutoHide; },
      setMenuBarVisibility: function(visible) { return browserWindowSetMenuBarVisibility(visible); },
      isMenuBarVisible: function() { return browserWindowMenuBarVisible; },
      removeMenu: function() { return browserWindowRemoveMenu(); },
      setMenu: function(menu) { return browserWindowSetMenu(menu); },
      setWindowButtonVisibility: function(visible) { return browserWindowSetWindowButtonVisibility(visible); },
      setWindowButtonPosition: function(position) { return browserWindowSetWindowButtonPosition(position); },
      getWindowButtonPosition: function() { return hostedWindowButtonPositionCopy(browserWindowButtonPosition); },
      setVibrancy: function(type, options) { return browserWindowSetVibrancy(type, options); },
      setBackgroundMaterial: function(material) { return browserWindowSetBackgroundMaterial(material); },
      setSheetOffset: function(offsetY, offsetX) { return browserWindowSetSheetOffset.apply(null, arguments); },
      isNormal: function() { return browserWindowIsNormal(); },
      isModal: function() { return browserWindowModal; },
      setDocumentEdited: function(edited) { return browserWindowSetDocumentEdited(edited); },
      isDocumentEdited: function() { return browserWindowDocumentEdited; },
      setRepresentedFilename: function(filename) { return browserWindowSetRepresentedFilename(filename); },
      getRepresentedFilename: function() { return browserWindowRepresentedFilename; },
      setParentWindow: function(parentWindow) { return browserWindowSetParentWindow(parentWindow); },
      getParentWindow: function() { return browserWindowGetParentWindow(); },
      getChildWindows: function() { return browserWindowGetChildWindows(); },
      getBounds: function() { return geometry.read('getBounds'); },
      setBounds: function(bounds) { return _browserWindowAction(id, 'setBounds', bounds || {}); },
      getSize: function() { return geometry.read('getSize'); },
      setSize: function(width, height) { return _browserWindowAction(id, 'setSize', width, height); },
      getContentSize: function() { return geometry.read('getContentSize'); },
      setContentSize: function(width, height, animate) { return _browserWindowAction(id, 'setContentSize', width, height, animate === true); },
      getMinimumSize: function() { return geometry.read('getMinimumSize'); },
      setMinimumSize: function(width, height) { return _browserWindowAction(id, 'setMinimumSize', width, height); },
      getMaximumSize: function() { return geometry.read('getMaximumSize'); },
      setMaximumSize: function(width, height) { return _browserWindowAction(id, 'setMaximumSize', width, height); },
      setAspectRatio: function(aspectRatio, extraSize) { return _browserWindowAction(id, 'setAspectRatio', Number(aspectRatio), extraSize || {}); },
      getPosition: function() { return geometry.read('getPosition'); },
      setPosition: function(x, y) { return _browserWindowAction(id, 'setPosition', x, y); },
      center: function() { return _browserWindowAction(id, 'center'); },
      isResizable: function() { return _browserWindowAction(id, 'isResizable'); },
      setResizable: function(flag) { return _browserWindowAction(id, 'setResizable', flag === true); },
      isMovable: function() { return _browserWindowAction(id, 'isMovable'); },
      setMovable: function(flag) { return _browserWindowAction(id, 'setMovable', flag === true); },
      isClosable: function() { return _browserWindowAction(id, 'isClosable'); },
      setClosable: function(flag) { return _browserWindowAction(id, 'setClosable', flag === true); },
      isMinimizable: function() { return _browserWindowAction(id, 'isMinimizable'); },
      setMinimizable: function(flag) { return _browserWindowAction(id, 'setMinimizable', flag === true); },
      isMaximizable: function() { return _browserWindowAction(id, 'isMaximizable'); },
      setMaximizable: function(flag) { return _browserWindowAction(id, 'setMaximizable', flag === true); },
      isFullScreen: function() { return _browserWindowAction(id, 'isFullScreen'); },
      setFullScreen: function(flag) { return browserWindowShapeAction('setFullScreen', flag === true); },
      isFullScreenable: function() { return _browserWindowAction(id, 'isFullScreenable'); },
      setFullScreenable: function(flag) { return _browserWindowAction(id, 'setFullScreenable', flag === true); },
      getOpacity: function() { return _browserWindowAction(id, 'getOpacity'); },
      setOpacity: function(opacity) { return _browserWindowAction(id, 'setOpacity', Number(opacity)); },
      hasShadow: function() { return _browserWindowAction(id, 'hasShadow'); },
      setHasShadow: function(flag) { return _browserWindowAction(id, 'setHasShadow', flag === true); },
      invalidateShadow: function() { return _browserWindowAction(id, 'invalidateShadow'); },
      setSkipTaskbar: function(flag) { return _browserWindowAction(id, 'setSkipTaskbar', flag === true); },
      setKiosk: function(flag) { return browserWindowShapeAction('setKiosk', flag === true); },
      isKiosk: function() { return _browserWindowAction(id, 'isKiosk'); },
      setVisibleOnAllWorkspaces: function(flag, options) { return _browserWindowAction(id, 'setVisibleOnAllWorkspaces', flag === true, options || {}); },
      isVisibleOnAllWorkspaces: function() { return _browserWindowAction(id, 'isVisibleOnAllWorkspaces'); },
      setContentProtection: function(flag) { return _browserWindowAction(id, 'setContentProtection', flag === true); },
      isContentProtected: function() { return _browserWindowAction(id, 'isContentProtected'); },
      setFocusable: function(flag) { return _browserWindowAction(id, 'setFocusable', flag === true); },
      isFocusable: function() { return _browserWindowAction(id, 'isFocusable'); },
      flashFrame: function(flag) { return _browserWindowAction(id, 'flashFrame', flag === true); },
      setProgressBar: function(progress, options) { return _browserWindowAction(id, 'setProgressBar', Number(progress), options || {}); },
      getMediaSourceId: function() {
        if (nativeHost) return Promise.reject(nativeIdentifierError('BrowserWindow.getMediaSourceId'));
        return _browserWindowAction(id, 'getMediaSourceId');
      },
      moveTop: function() { return _browserWindowAction(id, 'moveTop'); },
      moveAbove: function(mediaSourceId) { return _browserWindowAction(id, 'moveAbove', String(mediaSourceId || '')); },
      on: function(name, listener) { return addEventListener(name, listener, false); },
      addListener: function(name, listener) { return addEventListener(name, listener, false); },
      once: function(name, listener) { return addEventListener(name, listener, true); },
      off: function(name, listener) { return removeListener(name, listener); },
      removeListener: function(name, listener) { return removeListener(name, listener); },
      removeAllListeners: function(name) { return removeAllListeners(name); },
      close: function() {
        return _browserWindowAction(id, 'close').then(function(actionResult) {
          if (!actionResult || actionResult.closed !== true) throw new Error('ERR_ATOOLS_BROWSER_WINDOW_CLOSE_UNCONFIRMED: native host did not confirm closed=true');
          geometry.close();
          destroyed = true;
          delete _browserWindowEventDispatchers[id];
          delete _browserWindowHandles[id];
          return actionResult;
        });
      },
      isDestroyed: function() { return destroyed; }
    };
    Object.defineProperty(handle, '__atoolsApplyGeometry', { value: geometry.apply });
    Object.defineProperty(handle, '__atoolsObserveGeometryEvent', { value: function(event) { var dispatch = _browserWindowEventDispatchers[id]; if (dispatch) dispatch(event.event, event.args || [], event.target || '', event.geometrySnapshot); } });
    Object.defineProperty(handle, '__atoolsParentWindowId', {
      enumerable: false,
      configurable: true,
      value: function() { return browserWindowParentId; }
    });
    Object.defineProperty(handle, 'webContents', {
      enumerable: false,
      configurable: true,
      value: webContents
    });
    if (id) _browserWindowHandles[id] = handle;
    return handle;
  }
  var _atoolsNativeBrowserWindowBackgroundThrottling = true;
  _browserWindowBridge = (__ATOOLS_BROWSER_WINDOW_BRIDGE_FACTORY__)(window, {
    invoke: _nativeCall,
    createResolvedHandle: function(record) { return _createBrowserWindowHandle(record); },
    maxPendingCreates: 8,
    maxQueuedOperations: 32,
    onError: function(error) { console.error('[createBrowserWindow]', error); }
  });
  if (_atoolsBrowserWindowId && _atoolsBrowserWindowGeometry) _createBrowserWindowHandle({
    id: _atoolsBrowserWindowId, clientCreateId: _atoolsBrowserWindowGeometry.clientCreateId,
    geometrySnapshot: _atoolsBrowserWindowGeometry,
    ...(_atoolsWindowType === 'browserWindow' && _atoolsWindowHostKind === 'native'
      ? { backgroundThrottling: _atoolsNativeBrowserWindowBackgroundThrottling } : {}),
    hostKind: _atoolsWindowHostKind
  });
  var _atoolsNativeWindowDomControls = null;
  var _atoolsNativeWindowDragRegions = null;
  var _atoolsNativeAppRegionCssRuntime = null;
  var _atoolsNativeAppRegionCss = null;
  if (_atoolsWindowType === 'browserWindow' && _atoolsWindowHostKind === 'native' && _atoolsBrowserWindowId) {
    var nativeBrowserWindowSelf = _browserWindowHandles[_atoolsBrowserWindowId];
    if (nativeBrowserWindowSelf) _atoolsNativeWindowDomControls = (__ATOOLS_NATIVE_WINDOW_DOM_CONTROLS_FACTORY__)(window, {
      windowType: _atoolsWindowType, hostKind: _atoolsWindowHostKind, self: nativeBrowserWindowSelf,
      reportError: function(error) { try { console.error('[native BrowserWindow DOM control]', error); } catch (_) {} }
    });
    if (nativeBrowserWindowSelf) {
      _atoolsNativeAppRegionCss = (__ATOOLS_NATIVE_APP_REGION_CSS_FACTORY__)();
      _atoolsNativeAppRegionCssRuntime = (__ATOOLS_NATIVE_APP_REGION_CSS_RUNTIME_FACTORY__)(window, {
        windowType: _atoolsWindowType, hostKind: _atoolsWindowHostKind, self: nativeBrowserWindowSelf,
        rewrite: _atoolsNativeAppRegionCss,
        reportError: function(error) { try { console.error('[native BrowserWindow app-region CSS]', error); } catch (_) {} }
      });
      _atoolsNativeWindowDragRegions = (__ATOOLS_NATIVE_WINDOW_DRAG_REGIONS_FACTORY__)(window, {
        windowType: _atoolsWindowType, hostKind: _atoolsWindowHostKind, self: nativeBrowserWindowSelf,
        beginDrag: function(startedAtMs) {
          return _browserWindowAction(_atoolsBrowserWindowId, 'startDragging', { startedAtMs: startedAtMs });
        },
        reportError: function(error) { try { console.error('[native BrowserWindow app-region drag]', error); } catch (_) {} }
      });
    }
  }
  function _hasRuntimeUrlProtocol(value) {
`;
export default part;
