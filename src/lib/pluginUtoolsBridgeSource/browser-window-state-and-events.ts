const part = `    var record = result && typeof result === 'object' ? result : {};
    var nativeHost = record.hostKind === 'native';
    var id = String(record.id || '');
    var initialGeometry = record.geometrySnapshot;
    var geometry = (__ATOOLS_BROWSER_WINDOW_GEOMETRY_FACTORY__)(initialGeometry && initialGeometry.windowId === id && initialGeometry.clientCreateId === record.clientCreateId ? initialGeometry : null);
    var destroyed = false;
    var eventListeners = {};
    var webContentsEventListeners = {};
    var webContentsFindReqId = 0;
    var webContentsUrl = String(record.url || '');
    var webContentsTitle = String(record.title || '');
    var webContentsLoading = false;
    var webContentsHistory = webContentsUrl ? [webContentsUrl] : [];
    var webContentsHistoryIndex = webContentsHistory.length > 0 ? 0 : -1;
    var webContentsDevToolsOpened = false;
    var webContentsDevToolsFocused = false;
    var webContentsDevToolsMode = '';
    var webContentsDevToolsTitle = '';
    var webContentsZoomFactor = 1;
    var webContentsZoomLevel = 0;
    var webContentsVisualZoomMinimumLevel = 0;
    var webContentsVisualZoomMaximumLevel = 0;
    var webContentsAudioMuted = false;
    var webContentsCurrentlyAudible = false;
    var webContentsUserAgent = typeof record.userAgent === 'string' ? record.userAgent : String(navigator.userAgent || '');
    var webContentsFrameRate = normalizeFrameRate(record.frameRate || 60);
    var webContentsBackgroundThrottling = record.backgroundThrottling !== false;
    // Native BrowserWindow hosts do not own Electron/WebContents process identifiers.
    var webContentsProcessId = nativeHost ? 0 : hostedPositiveInteger(record.processId, hostedNumericId(id, 1));
    var webContentsOSProcessId = nativeHost ? 0 : hostedPositiveInteger(record.osProcessId, 100000 + webContentsProcessId);
    var webContentsCrashed = record.crashed === true;
    var webContentsMediaSourceId = nativeHost ? ''
      : typeof record.webContentsMediaSourceId === 'string' && record.webContentsMediaSourceId
        ? record.webContentsMediaSourceId
        : 'web-contents:' + hostedNumericId(id, 1) + ':0';
    var webContentsFocused = record.webContentsFocused === true || record.focused === true;
    var webContentsBeingCaptured = record.webContentsBeingCaptured === true;
    var webContentsIgnoreMenuShortcuts = record.ignoreMenuShortcuts === true;
    function hostedBrowserWindowHexPair(value) {
      var number = Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
      return number.toString(16).padStart(2, '0');
    }
    function normalizeHostedBrowserWindowBackgroundColor(value, fallback) {
      var raw = String(value == null ? '' : value).trim();
      var fallbackColor = typeof fallback === 'string' && /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : '#ffffff';
      var hex = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
      if (hex) {
        var body = hex[1];
        if (body.length === 3) return ('#' + body.split('').map(function(ch) { return ch + ch; }).join('')).toLowerCase();
        if (body.length === 4) return ('#' + body.slice(1).split('').map(function(ch) { return ch + ch; }).join('')).toLowerCase();
        if (body.length === 8) return ('#' + body.slice(2)).toLowerCase();
        return ('#' + body).toLowerCase();
      }
      var lower = raw.toLowerCase();
      if (lower.indexOf('rgb(') === 0 || lower.indexOf('rgba(') === 0) {
        var openIndex = raw.indexOf('(');
        var closeIndex = raw.indexOf(')', openIndex + 1);
        var rgbParts = raw.slice(openIndex + 1, closeIndex >= 0 ? closeIndex : raw.length).split(',');
        if (rgbParts.length >= 3) return '#' + hostedBrowserWindowHexPair(rgbParts[0]) + hostedBrowserWindowHexPair(rgbParts[1]) + hostedBrowserWindowHexPair(rgbParts[2]);
      }
      var namedColors = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', blueviolet: '#8a2be2' };
      return namedColors[raw] || fallbackColor;
    }
    function hostedFiniteNumber(value, fallback) {
      var numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    }
    function hostedPlainOptions(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function hostedWindowButtonPosition(value) {
      if (value == null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return {
        x: hostedFiniteNumber(value.x, 0),
        y: hostedFiniteNumber(value.y, 0)
      };
    }
    function hostedWindowButtonPositionCopy(value) {
      return value ? { x: value.x, y: value.y } : null;
    }
    var browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(record.backgroundColor || record.backgroundcolor || '#ffffff');
    var browserWindowMenuBarAutoHide = record.menuBarAutoHide === true || record.menubarautohide === true || record.autoHideMenuBar === true || record.autohidemenubar === true;
    var browserWindowMenuRemoved = record.menuRemoved === true || record.menuremoved === true;
    var browserWindowMenuBarVisible = !browserWindowMenuRemoved && record.menuBarVisible !== false && record.menubarvisible !== false;
    var browserWindowButtonVisible = record.windowButtonVisible !== false && record.windowbuttonvisible !== false;
    var browserWindowButtonPosition = hostedWindowButtonPosition(record.windowButtonPosition || record.windowbuttonposition || null);
    var browserWindowVibrancy = typeof record.vibrancy === 'string' ? record.vibrancy : '';
    var browserWindowVibrancyOptions = hostedPlainOptions(record.vibrancyOptions || record.vibrancyoptions);
    var browserWindowBackgroundMaterial = typeof record.backgroundMaterial === 'string' ? record.backgroundMaterial : typeof record.backgroundmaterial === 'string' ? record.backgroundmaterial : 'none';
    var browserWindowSheetOffsetY = hostedFiniteNumber(record.sheetOffsetY || record.sheetoffsety, 0);
    var browserWindowSheetOffsetX = hostedFiniteNumber(record.sheetOffsetX || record.sheetoffsetx, 0);
    var browserWindowDocumentEdited = record.documentEdited === true || record.documentedited === true;
    var browserWindowRepresentedFilename = typeof record.representedFilename === 'string'
      ? record.representedFilename
      : typeof record.representedfilename === 'string'
        ? record.representedfilename
        : '';
    var browserWindowModal = record.modal === true;
    var browserWindowParentId = typeof record.parentWindowId === 'string' && record.parentWindowId
      ? record.parentWindowId
      : typeof record.parentwindowid === 'string' && record.parentwindowid
        ? record.parentwindowid
        : null;
    var browserWindowMinimized = record.minimized === true;
    var browserWindowMaximized = record.maximized === true;
    var browserWindowFullScreen = record.fullScreen === true || record.fullscreen === true;
    var browserWindowKiosk = record.kiosk === true;
    function hostedNumericId(value, fallback) {
      var match = String(value || '').match(/(\\d+)$/);
      var numeric = match ? Number(match[1]) : Number(fallback);
      return Number.isInteger(numeric) && numeric > 0 ? numeric : 1;
    }
    function hostedPositiveInteger(value, fallback) {
      var numeric = Number(value);
      if (Number.isInteger(numeric) && numeric > 0) return numeric;
      var fallbackNumeric = Number(fallback);
      return Number.isInteger(fallbackNumeric) && fallbackNumeric > 0 ? fallbackNumeric : 1;
    }
    function nativeIdentifierError(identifier) {
      var error = new Error(identifier + ' is unavailable for native BrowserWindow hosts');
      error.code = 'ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED';
      return error;
    }
    function nativeIdentifierUnsupported(identifier) {
      throw nativeIdentifierError(identifier);
    }
    function eventList(name, create) {
      var key = String(name || '');
      if (!key) return [];
      if (!eventListeners[key] && create) eventListeners[key] = [];
      return eventListeners[key] || [];
    }
    function emitEvent(name, args) {
      var listeners = eventList(name, false).slice();
      listeners.forEach(function(entry) {
        try {
          entry.listener.apply(null, args || []);
        } catch (err) {
          console.error('[browserWindow event]', err);
        }
        if (entry.once) removeListener(name, entry.listener);
      });
    }
    function addEventListener(name, listener, once) {
      if (typeof listener !== 'function') return handle;
      eventList(name, true).push({ listener: listener, once: once === true });
      return handle;
    }
    function removeListener(name, listener) {
      var key = String(name || '');
      if (!eventListeners[key]) return handle;
      eventListeners[key] = eventListeners[key].filter(function(entry) {
        return entry.listener !== listener;
      });
      if (eventListeners[key].length === 0) delete eventListeners[key];
      return handle;
    }
    function removeAllListeners(name) {
      if (typeof name === 'string' && name) delete eventListeners[name];
      else eventListeners = {};
      return handle;
    }
    function webContentsEventList(name, create) {
      var key = String(name || '');
      if (!key) return [];
      if (!webContentsEventListeners[key] && create) webContentsEventListeners[key] = [];
      return webContentsEventListeners[key] || [];
    }
    function emitWebContentsEvent(name, args) {
      var listeners = webContentsEventList(name, false).slice();
      var event = {
        type: String(name || ''),
        sender: webContents,
        preventDefault: function() {},
        defaultPrevented: false
      };
      if (event.type === 'audio-state-changed') {
        var audioArg = Array.isArray(args) && args.length > 0 ? args[0] : null;
        var audible = typeof audioArg === 'boolean'
          ? audioArg
          : audioArg && typeof audioArg === 'object' && typeof audioArg.audible === 'boolean'
            ? audioArg.audible
            : webContentsCurrentlyAudible;
        event.audible = audible;
      }
      listeners.forEach(function(entry) {
        try {
          entry.listener.apply(null, [event].concat(args || []));
        } catch (err) {
          console.error('[browserWindow webContents event]', err);
        }
        if (entry.once) removeWebContentsListener(name, entry.listener);
      });
    }
    function addWebContentsListener(name, listener, once) {
      if (typeof listener !== 'function') return webContents;
      webContentsEventList(name, true).push({ listener: listener, once: once === true });
      return webContents;
    }
    function removeWebContentsListener(name, listener) {
      var key = String(name || '');
      if (!webContentsEventListeners[key]) return webContents;
      webContentsEventListeners[key] = webContentsEventListeners[key].filter(function(entry) {
        return entry.listener !== listener;
      });
      if (webContentsEventListeners[key].length === 0) delete webContentsEventListeners[key];
      return webContents;
    }
    function removeAllWebContentsListeners(name) {
      if (typeof name === 'string' && name) delete webContentsEventListeners[name];
      else webContentsEventListeners = {};
      return webContents;
    }
    function syncWebContentsNavigationState(result, options) {
`;
export default part;
