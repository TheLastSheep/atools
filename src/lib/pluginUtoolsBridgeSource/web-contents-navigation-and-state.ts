const part = `      webContentsLoading = true;
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(function(result) {
        webContentsLoading = false;
        return syncWebContentsNavigationState(result, { push: action === 'loadURL' || action === 'webContents.loadURL' });
      }).catch(function(err) {
        webContentsLoading = false;
        throw err;
      });
    }
    function navigationHistoryOffset(value) {
      var offset = Number(value);
      return Number.isFinite(offset) ? Math.trunc(offset) : 0;
    }
    function navigationHistoryIndex(value) {
      var index = Number(value);
      return Number.isFinite(index) ? Math.trunc(index) : -1;
    }
    function navigationHistoryCanGoToOffset(value) {
      var targetIndex = webContentsHistoryIndex + navigationHistoryOffset(value);
      return targetIndex >= 0 && targetIndex < webContentsHistory.length && targetIndex !== webContentsHistoryIndex;
    }
    function navigationHistoryAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow ' + action + ']', err);
      });
      return undefined;
    }
    function navigationHistoryClear() {
      if (webContentsUrl) {
        webContentsHistory = [webContentsUrl];
        webContentsHistoryIndex = 0;
      } else {
        webContentsHistory = [];
        webContentsHistoryIndex = -1;
      }
      _browserWindowAction(id, 'webContents.navigationHistory.clear').then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow webContents.navigationHistory.clear]', err);
      });
      return undefined;
    }
    function webContentsStop() {
      webContentsLoading = false;
      _browserWindowAction(id, 'webContents.stop').then(syncWebContentsNavigationState).catch(function(err) {
        console.error('[browserWindow webContents.stop]', err);
      });
      return undefined;
    }
    function syncWebContentsCrashState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.crashed === 'boolean') webContentsCrashed = record.crashed;
      return result;
    }
    function webContentsForcefullyCrashRenderer() {
      webContentsCrashed = true;
      _browserWindowAction(id, 'webContents.forcefullyCrashRenderer').then(syncWebContentsCrashState).catch(function(err) {
        console.error('[browserWindow webContents.forcefullyCrashRenderer]', err);
      });
      return undefined;
    }
    function syncWebContentsDevToolsState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.devToolsOpened === 'boolean') webContentsDevToolsOpened = record.devToolsOpened;
      if (typeof record.devToolsFocused === 'boolean') webContentsDevToolsFocused = record.devToolsFocused;
      if (typeof record.devToolsMode === 'string') webContentsDevToolsMode = record.devToolsMode;
      if (typeof record.devToolsTitle === 'string') webContentsDevToolsTitle = record.devToolsTitle;
      if (!webContentsDevToolsOpened) webContentsDevToolsFocused = false;
      return result;
    }
    function syncWebContentsDevToolsEvent(name, args) {
      var eventName = String(name || '');
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      if (firstArg && typeof firstArg === 'object') {
        syncWebContentsDevToolsState(firstArg);
        return;
      }
      if (eventName === 'devtools-opened') {
        webContentsDevToolsOpened = true;
        webContentsDevToolsFocused = true;
      }
      if (eventName === 'devtools-closed') {
        webContentsDevToolsOpened = false;
        webContentsDevToolsFocused = false;
      }
    }
    function webContentsDevToolsAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncWebContentsDevToolsState);
    }
    function normalizeInspectCoordinate(value) {
      var numeric = Number(value);
      return Number.isFinite(numeric) ? Math.round(numeric) : 0;
    }
    function webContentsInspectElement(xValue, yValue) {
      normalizeInspectCoordinate(xValue);
      normalizeInspectCoordinate(yValue);
      throw _hostedBrowserWindowUnsupported('webContents.inspectElement');
    }
    function zoomLevelFromFactor(factor) {
      return Math.log(factor) / Math.log(1.2);
    }
    function zoomFactorFromLevel(level) {
      return Math.pow(1.2, level);
    }
    function normalizeZoomFactor(value) {
      var factor = Number(value);
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error('webContents.setZoomFactor requires a factor greater than 0');
      }
      return factor;
    }
    function normalizeZoomLevel(value) {
      var level = Number(value);
      if (!Number.isFinite(level)) {
        throw new Error('webContents.setZoomLevel requires a finite level');
      }
      return level;
    }
    function normalizeFrameRate(value) {
      var rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('webContents.setFrameRate requires a positive frame rate');
      }
      return Math.min(240, Math.max(1, Math.round(rate)));
    }
    function syncWebContentsRuntimeState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.userAgent === 'string') webContentsUserAgent = record.userAgent;
      if (typeof record.frameRate === 'number' && Number.isFinite(record.frameRate) && record.frameRate > 0) {
        webContentsFrameRate = normalizeFrameRate(record.frameRate);
      }
      if (typeof record.backgroundThrottling === 'boolean') {
        webContentsBackgroundThrottling = record.backgroundThrottling;
      }
      if (!nativeHost && Number.isInteger(record.processId) && record.processId > 0) webContentsProcessId = record.processId;
      if (!nativeHost && Number.isInteger(record.osProcessId) && record.osProcessId > 0) webContentsOSProcessId = record.osProcessId;
      return result;
    }
    function webContentsSetUserAgent(value) {
      var userAgent = String(value == null ? '' : value);
      webContentsUserAgent = userAgent;
      _browserWindowAction(id, 'webContents.setUserAgent', userAgent).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setUserAgent]', err);
      });
      return undefined;
    }
    function webContentsSetFrameRate(value) {
      var frameRate = normalizeFrameRate(value);
      webContentsFrameRate = frameRate;
      _browserWindowAction(id, 'webContents.setFrameRate', frameRate).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setFrameRate]', err);
      });
      return undefined;
    }
    function webContentsSetBackgroundThrottling(value) {
      if (nativeHost) nativeIdentifierUnsupported('webContents.setBackgroundThrottling');
      var backgroundThrottling = value !== false;
      webContentsBackgroundThrottling = backgroundThrottling;
      _browserWindowAction(id, 'webContents.setBackgroundThrottling', backgroundThrottling).then(syncWebContentsRuntimeState).catch(function(err) {
        console.error('[browserWindow webContents.setBackgroundThrottling]', err);
      });
      return undefined;
    }
    function syncWebContentsZoomState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.zoomFactor === 'number' && Number.isFinite(record.zoomFactor) && record.zoomFactor > 0) {
        webContentsZoomFactor = record.zoomFactor;
      }
      if (typeof record.zoomLevel === 'number' && Number.isFinite(record.zoomLevel)) {
        webContentsZoomLevel = record.zoomLevel;
      }
      if (typeof record.minimumLevel === 'number' && Number.isFinite(record.minimumLevel)) {
        webContentsVisualZoomMinimumLevel = record.minimumLevel;
      }
      if (typeof record.maximumLevel === 'number' && Number.isFinite(record.maximumLevel)) {
        webContentsVisualZoomMaximumLevel = record.maximumLevel;
      }
      return result;
    }
    function syncWebContentsAudioState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.audioMuted === 'boolean') webContentsAudioMuted = record.audioMuted;
      if (typeof record.currentlyAudible === 'boolean') webContentsCurrentlyAudible = record.currentlyAudible;
      if (typeof record.audible === 'boolean') webContentsCurrentlyAudible = record.audible;
      if (webContentsAudioMuted) webContentsCurrentlyAudible = false;
      return result;
    }
    function syncWebContentsAudioEvent(name, args) {
      if (String(name || '') !== 'audio-state-changed') return;
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      var audible = typeof firstArg === 'boolean'
        ? firstArg
        : firstArg && typeof firstArg === 'object' && typeof firstArg.audible === 'boolean'
          ? firstArg.audible
          : null;
      if (typeof audible === 'boolean') webContentsCurrentlyAudible = audible && !webContentsAudioMuted;
    }
    function syncWebContentsCrashEvent(name) {
      if (String(name || '') === 'render-process-gone') webContentsCrashed = true;
    }
    function syncWebContentsFocusState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.webContentsFocused === 'boolean') webContentsFocused = record.webContentsFocused;
      else if (typeof record.focused === 'boolean') webContentsFocused = record.focused;
      return result;
    }
    function syncWebContentsShortcutState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.ignoreMenuShortcuts === 'boolean') webContentsIgnoreMenuShortcuts = record.ignoreMenuShortcuts;
      return result;
    }
    function syncWebContentsWindowEvent(name, args) {
      var eventName = String(name || '');
      var firstArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
      if (firstArg && typeof firstArg === 'object' && typeof firstArg.focused === 'boolean') {
        webContentsFocused = firstArg.focused;
      } else if (eventName === 'focus') {
        webContentsFocused = true;
      } else if (eventName === 'blur' || eventName === 'hide' || eventName === 'closed') {
        webContentsFocused = false;
      }
    }
    function browserWindowFocusAction(action) {
      return _browserWindowAction(id, action).then(syncWebContentsFocusState);
    }
    function webContentsFocus() {
      webContentsFocused = true;
      _browserWindowAction(id, 'webContents.focus').then(syncWebContentsFocusState).catch(function(err) {
        console.error('[browserWindow webContents.focus]', err);
      });
      return undefined;
    }
    function webContentsSetIgnoreMenuShortcuts(ignore) {
      var nextIgnore = ignore === true;
      webContentsIgnoreMenuShortcuts = nextIgnore;
      _browserWindowAction(id, 'webContents.setIgnoreMenuShortcuts', nextIgnore).then(syncWebContentsShortcutState).catch(function(err) {
        console.error('[browserWindow webContents.setIgnoreMenuShortcuts]', err);
      });
      return undefined;
    }
    function webContentsSetAudioMuted(mutedValue) {
      var muted = mutedValue === true;
      webContentsAudioMuted = muted;
      if (muted) webContentsCurrentlyAudible = false;
      _browserWindowAction(id, 'webContents.setAudioMuted', muted).then(syncWebContentsAudioState).catch(function(err) {
        console.error('[browserWindow webContents.setAudioMuted]', err);
      });
      return undefined;
    }
    function webContentsSetZoomFactor(factorValue) {
      var factor = normalizeZoomFactor(factorValue);
      webContentsZoomFactor = factor;
      webContentsZoomLevel = zoomLevelFromFactor(factor);
      _browserWindowAction(id, 'webContents.setZoomFactor', factor).then(syncWebContentsZoomState).catch(function(err) {
        console.error('[browserWindow webContents.setZoomFactor]', err);
      });
      return undefined;
    }
    function webContentsSetZoomLevel(levelValue) {
      var level = normalizeZoomLevel(levelValue);
      webContentsZoomLevel = level;
      webContentsZoomFactor = zoomFactorFromLevel(level);
      _browserWindowAction(id, 'webContents.setZoomLevel', level).then(syncWebContentsZoomState).catch(function(err) {
        console.error('[browserWindow webContents.setZoomLevel]', err);
      });
      return undefined;
    }
    function webContentsInsertText(text) {
      return _browserWindowAction(id, 'webContents.insertText', String(text == null ? '' : text)).then(function() {
        return undefined;
      });
    }
    function webContentsEditAction(action) {
      throw _hostedBrowserWindowUnsupported(action);
    }
    function hostedWebContentsBytes(result) {
`;
export default part;
