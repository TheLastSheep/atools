const part = `      var record = result && typeof result === 'object' ? result : {};
      var nextUrl = typeof record.url === 'string' ? record.url : webContentsUrl;
      var nextTitle = typeof record.title === 'string' ? record.title : webContentsTitle;
      var push = options && options.push === true;
      if (push && nextUrl) {
        webContentsHistory = webContentsHistory.slice(0, webContentsHistoryIndex + 1);
        webContentsHistory.push(nextUrl);
        webContentsHistoryIndex = webContentsHistory.length - 1;
      }
      if (Number.isInteger(record.historyIndex)) webContentsHistoryIndex = record.historyIndex;
      if (Number.isInteger(record.historyLength)) {
        var historyLength = Math.max(0, record.historyLength);
        if (historyLength > 0 && webContentsHistory.length !== historyLength) {
          var rebuilt = webContentsHistory.slice(0, historyLength);
          while (rebuilt.length < historyLength) rebuilt.push(rebuilt[rebuilt.length - 1] || nextUrl);
          webContentsHistory = rebuilt;
        }
      }
      if (nextUrl && webContentsHistory.length === 0) {
        webContentsHistory = [nextUrl];
        webContentsHistoryIndex = 0;
      }
      if (webContentsHistoryIndex < 0 && webContentsHistory.length > 0) webContentsHistoryIndex = 0;
      if (webContentsHistoryIndex >= webContentsHistory.length) webContentsHistoryIndex = webContentsHistory.length - 1;
      webContentsUrl = nextUrl;
      webContentsTitle = nextTitle;
      webContentsLoading = record.loading === true;
      if (typeof record.crashed === 'boolean') webContentsCrashed = record.crashed;
      return result;
    }
    function syncBrowserWindowBackgroundColor(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof result === 'string') browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(result, browserWindowBackgroundColor);
      if (typeof record.backgroundColor === 'string') browserWindowBackgroundColor = normalizeHostedBrowserWindowBackgroundColor(record.backgroundColor, browserWindowBackgroundColor);
      return result;
    }
    function browserWindowSetBackgroundColor(value) {
      var backgroundColor = normalizeHostedBrowserWindowBackgroundColor(value, browserWindowBackgroundColor);
      browserWindowBackgroundColor = backgroundColor;
      _browserWindowAction(id, 'setBackgroundColor', backgroundColor).then(syncBrowserWindowBackgroundColor).catch(function(err) {
        console.error('[browserWindow setBackgroundColor]', err);
      });
      return undefined;
    }
    function syncBrowserWindowMenuBarState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.menuBarAutoHide === 'boolean') browserWindowMenuBarAutoHide = record.menuBarAutoHide;
      if (typeof record.menuRemoved === 'boolean') browserWindowMenuRemoved = record.menuRemoved;
      if (typeof record.menuBarVisible === 'boolean') browserWindowMenuBarVisible = record.menuBarVisible && !browserWindowMenuRemoved;
      if (browserWindowMenuRemoved) browserWindowMenuBarVisible = false;
      return result;
    }
    function browserWindowSetAutoHideMenuBar(hide) {
      browserWindowMenuBarAutoHide = hide === true;
      _browserWindowAction(id, 'setAutoHideMenuBar', browserWindowMenuBarAutoHide).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setAutoHideMenuBar]', err);
      });
      return undefined;
    }
    function browserWindowSetMenuBarVisibility(visible) {
      browserWindowMenuBarVisible = visible === true && !browserWindowMenuRemoved;
      _browserWindowAction(id, 'setMenuBarVisibility', browserWindowMenuBarVisible).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setMenuBarVisibility]', err);
      });
      return undefined;
    }
    function browserWindowRemoveMenu() {
      browserWindowMenuRemoved = true;
      browserWindowMenuBarVisible = false;
      _browserWindowAction(id, 'removeMenu').then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow removeMenu]', err);
      });
      return undefined;
    }
    function browserWindowSetMenu(menu) {
      browserWindowMenuRemoved = menu == null;
      browserWindowMenuBarVisible = !browserWindowMenuRemoved;
      _browserWindowAction(id, 'setMenu', menu == null ? null : menu).then(syncBrowserWindowMenuBarState).catch(function(err) {
        console.error('[browserWindow setMenu]', err);
      });
      return undefined;
    }
    function syncBrowserWindowTitlebarMaterialState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.windowButtonVisible === 'boolean') browserWindowButtonVisible = record.windowButtonVisible;
      if (Object.prototype.hasOwnProperty.call(record, 'windowButtonPosition')) browserWindowButtonPosition = hostedWindowButtonPosition(record.windowButtonPosition);
      if (typeof record.vibrancy === 'string') browserWindowVibrancy = record.vibrancy;
      if (record.vibrancyOptions && typeof record.vibrancyOptions === 'object' && !Array.isArray(record.vibrancyOptions)) browserWindowVibrancyOptions = record.vibrancyOptions;
      if (typeof record.backgroundMaterial === 'string') browserWindowBackgroundMaterial = record.backgroundMaterial;
      if (typeof record.sheetOffsetY === 'number') browserWindowSheetOffsetY = record.sheetOffsetY;
      if (typeof record.sheetOffsetX === 'number') browserWindowSheetOffsetX = record.sheetOffsetX;
      return result;
    }
    function browserWindowSetWindowButtonVisibility(visible) {
      browserWindowButtonVisible = visible === true;
      _browserWindowAction(id, 'setWindowButtonVisibility', browserWindowButtonVisible).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setWindowButtonVisibility]', err);
      });
      return undefined;
    }
    function browserWindowSetWindowButtonPosition(position) {
      browserWindowButtonPosition = hostedWindowButtonPosition(position);
      _browserWindowAction(id, 'setWindowButtonPosition', hostedWindowButtonPositionCopy(browserWindowButtonPosition)).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setWindowButtonPosition]', err);
      });
      return undefined;
    }
    function browserWindowSetVibrancy(type, options) {
      var vibrancy = type == null || String(type) === '' ? null : String(type);
      var vibrancyOptions = hostedPlainOptions(options);
      browserWindowVibrancy = vibrancy || '';
      browserWindowVibrancyOptions = vibrancyOptions;
      _browserWindowAction(id, 'setVibrancy', vibrancy, vibrancyOptions).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setVibrancy]', err);
      });
      return undefined;
    }
    function browserWindowSetBackgroundMaterial(material) {
      var backgroundMaterial = material == null || String(material) === '' ? 'none' : String(material);
      browserWindowBackgroundMaterial = backgroundMaterial;
      _browserWindowAction(id, 'setBackgroundMaterial', backgroundMaterial).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setBackgroundMaterial]', err);
      });
      return undefined;
    }
    function browserWindowSetSheetOffset(offsetY, offsetX) {
      browserWindowSheetOffsetY = hostedFiniteNumber(offsetY, 0);
      browserWindowSheetOffsetX = hostedFiniteNumber(offsetX, 0);
      var payload = [browserWindowSheetOffsetY];
      if (arguments.length > 1) payload.push(browserWindowSheetOffsetX);
      _browserWindowAction.apply(null, [id, 'setSheetOffset'].concat(payload)).then(syncBrowserWindowTitlebarMaterialState).catch(function(err) {
        console.error('[browserWindow setSheetOffset]', err);
      });
      return undefined;
    }
    function syncBrowserWindowShapeState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.minimized === 'boolean') browserWindowMinimized = record.minimized;
      if (typeof record.maximized === 'boolean') browserWindowMaximized = record.maximized;
      if (typeof record.fullScreen === 'boolean') browserWindowFullScreen = record.fullScreen;
      if (typeof record.fullscreen === 'boolean') browserWindowFullScreen = record.fullscreen;
      if (typeof record.kiosk === 'boolean') browserWindowKiosk = record.kiosk;
      return result;
    }
    function browserWindowShapeAction(action) {
      var payload = Array.prototype.slice.call(arguments, 1);
      return _browserWindowAction.apply(null, [id, action].concat(payload)).then(syncBrowserWindowShapeState);
    }
    function browserWindowIsNormal() {
      return !browserWindowMinimized && !browserWindowMaximized && !browserWindowFullScreen && !browserWindowKiosk;
    }
    function syncBrowserWindowDocumentParentState(result) {
      var record = result && typeof result === 'object' ? result : {};
      if (typeof record.documentEdited === 'boolean') browserWindowDocumentEdited = record.documentEdited;
      if (typeof record.representedFilename === 'string') browserWindowRepresentedFilename = record.representedFilename;
      if (typeof record.modal === 'boolean') browserWindowModal = record.modal;
      if (Object.prototype.hasOwnProperty.call(record, 'parentWindowId')) {
        browserWindowParentId = typeof record.parentWindowId === 'string' && record.parentWindowId ? record.parentWindowId : null;
      }
      return result;
    }
    function browserWindowSetDocumentEdited(edited) {
      browserWindowDocumentEdited = edited === true;
      _browserWindowAction(id, 'setDocumentEdited', browserWindowDocumentEdited).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setDocumentEdited]', err);
      });
      return undefined;
    }
    function browserWindowSetRepresentedFilename(filename) {
      browserWindowRepresentedFilename = String(filename == null ? '' : filename);
      _browserWindowAction(id, 'setRepresentedFilename', browserWindowRepresentedFilename).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setRepresentedFilename]', err);
      });
      return undefined;
    }
    function hostedBrowserWindowParentId(parentWindow) {
      if (parentWindow == null) return null;
      if (parentWindow && typeof parentWindow === 'object' && typeof parentWindow.id === 'string' && parentWindow.id) return parentWindow.id;
      return null;
    }
    function browserWindowSetParentWindow(parentWindow) {
      browserWindowParentId = hostedBrowserWindowParentId(parentWindow);
      _browserWindowAction(id, 'setParentWindow', browserWindowParentId).then(syncBrowserWindowDocumentParentState).catch(function(err) {
        console.error('[browserWindow setParentWindow]', err);
      });
      return undefined;
    }
    function browserWindowGetParentWindow() {
      if (!browserWindowParentId) return null;
      return _browserWindowHandles[browserWindowParentId] || null;
    }
    function browserWindowGetChildWindows() {
      var children = [];
      Object.keys(_browserWindowHandles).forEach(function(key) {
        var childHandle = _browserWindowHandles[key];
        if (childHandle && typeof childHandle.__atoolsParentWindowId === 'function' && childHandle.__atoolsParentWindowId() === id) {
          children.push(childHandle);
        }
      });
      return children;
    }
    function webContentsNavigationAction(action) {
`;
export default part;
