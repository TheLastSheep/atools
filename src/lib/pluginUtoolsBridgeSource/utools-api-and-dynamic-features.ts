const part = `  var _atoolsEntryMode = __ATOOLS_ENTRY_MODE__;
  var _dbListeners = { change: [], docs: [] };
  var _mainPushCallback = null;
  var _mainPushSelectCallback = null;
  var _mainPushConfig = __ATOOLS_MAIN_PUSH_CONFIG__;
  var _mainPushBridge = _atoolsEntryMode !== 'preload' && _mainPushConfig ? (__ATOOLS_MAIN_PUSH_FACTORY__)(window, _mainPushConfig,
    __ATOOLS_MAIN_PUSH_BUDGET_FACTORY__, __ATOOLS_MAIN_PUSH_PRESENTATION_FACTORY__) : null;
  function _eventDetail(event) {
    return event && event.detail && typeof event.detail === 'object' ? event.detail : {};
  }
  function _pluginEnterAction(detail) {
    detail = detail || {};
    var payload = Object.prototype.hasOwnProperty.call(detail, 'payload') ? detail.payload : __ACTION_PAYLOAD__;
    var action = {
      code: detail.code || __FEATURE_CODE__,
      type: detail.type || __ACTION_ENTRY_TYPE__,
      payload: payload,
      from: detail.from || 'main'
    };
    if (Object.prototype.hasOwnProperty.call(detail, 'option')) action.option = detail.option;
    if (Object.prototype.hasOwnProperty.call(detail, 'inputState')) action.inputState = detail.inputState;
    return action;
  }
  function _emitMainPush(action, reqId) {
    if (_atoolsEntryMode === 'preload') return;
    if (_mainPushBridge) return;
    if (typeof _mainPushCallback !== 'function') return;
    var results = [];
    try {
      var returned = _mainPushCallback(action || _pluginEnterAction({}));
      results = Array.isArray(returned) ? returned : [];
    } catch (err) {
      console.error('[onMainPush]', err);
    }
    if (reqId != null) {
      window.parent.postMessage({
        __ipc_main_push_result__: true,
        reqId: reqId,
        results: results
      }, '*');
    }
  }
  function _emitMainPushSelect(action) {
    if (_atoolsEntryMode === 'preload') return;
    if (_mainPushBridge) return;
    if (typeof _mainPushSelectCallback !== 'function') return;
    try {
      _mainPushSelectCallback(action || _pluginEnterAction({}));
    } catch (err) {
      console.error('[onMainPush select]', err);
    }
  }
  function _emitDbPull(docs) {
    var payload = Array.isArray(docs) ? docs : [];
    _dbListeners.docs.slice().forEach(function(cb) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[onDbPull]', err);
      }
    });
  }
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__ipc_db_pull__) {
      _emitDbPull(e.data.docs);
    }
    if (e.data && e.data.__ipc_main_push__) {
      _emitMainPush(e.data.action, e.data.reqId);
    }
    if (e.data && e.data.__ipc_main_push_select__) {
      _emitMainPushSelect(e.data.action);
    }
  });
  window.__atools_dynamic_features__ = {};
  function _dynamicFeatureList() {
    return Object.keys(window.__atools_dynamic_features__).map(function(code) {
      return window.__atools_dynamic_features__[code];
    });
  }
  function _normalizeDynamicFeature(feature) {
    if (!feature || typeof feature !== 'object') return null;
    var code = feature.code || feature.feature_code || feature.cmd || feature.name;
    if (!code) return null;
    code = String(code);
    var label = feature.label || feature.explain || feature.title || code;
    var explain = feature.explain || feature.description || feature.label || '';
    return {
      code: code,
      label: String(label),
      explain: String(explain)
    };
  }
  function _postDynamicFeatureUpdate(action, features, codes) {
    window.parent.postMessage({
      __ipc_dynamic_feature__: true,
      action: action,
      features: features || [],
      codes: codes || [],
      allFeatures: _dynamicFeatureList()
    }, '*');
  }
  function _setDynamicFeatures(features) {
    var list = Array.isArray(features) ? features : [features];
    var normalized = [];
    list.forEach(function(feature) {
      var item = _normalizeDynamicFeature(feature);
      if (!item) return;
      window.__atools_dynamic_features__[item.code] = item;
      normalized.push(item);
    });
    _postDynamicFeatureUpdate('set', normalized, []);
    return _dynamicFeatureList();
  }
  function _removeDynamicFeatures(features) {
    var list = Array.isArray(features) ? features : [features];
    var codes = [];
    list.forEach(function(feature) {
      var code = typeof feature === 'string'
        ? feature
        : feature && typeof feature === 'object'
          ? feature.code || feature.feature_code || feature.cmd || feature.name
          : '';
      if (!code) return;
      code = String(code);
      delete window.__atools_dynamic_features__[code];
      codes.push(code);
    });
    _postDynamicFeatureUpdate('remove', [], codes);
    return _dynamicFeatureList();
  }
  function _setPluginHeight(height) {
    var numeric = Number(height);
    if (!Number.isFinite(numeric) || numeric <= 0) return false;
    var normalized = Math.max(120, Math.min(900, Math.round(numeric)));
    window.parent.postMessage({ __ipc_plugin_height__: true, height: normalized }, '*');
    return normalized;
  }
  function _isDarkColors() {
    if (typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function _fileIconDataUrl(filePath) {
    var raw = String(filePath || '').trim();
    var name = raw === 'folder'
      ? 'DIR'
      : (raw.split(/[\\/]/).pop() || raw || 'FILE');
    var ext = name.charAt(0) === '.'
      ? name
      : (name.indexOf('.') >= 0 ? '.' + name.split('.').pop() : name);
    var label = String(ext || 'FILE')
      .replace(/[^a-zA-Z0-9.]/g, '')
      .slice(0, 6)
      .toUpperCase() || 'FILE';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<rect x="12" y="6" width="40" height="52" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>'
      + '<path d="M40 6v14h12" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/>'
      + '<text x="32" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#334155">'
      + label
      + '</text></svg>';
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }
  function _bridgeNumber(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : 0;
  }
  function _contextMenuTagName(target) {
    return target && typeof target.tagName === 'string'
      ? target.tagName.toUpperCase().slice(0, 32)
      : '';
  }
  function _contextMenuEditable(target, tagName) {
    if (!target) return false;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    return target.isContentEditable === true;
  }
  function _contextMenuSelectedText() {
    try {
      if (typeof window.getSelection !== 'function') return '';
      return String(window.getSelection() || '').slice(0, 200);
    } catch (err) {
      return '';
    }
  }
  function _emitPluginContextMenu(event) {
    var tagName = _contextMenuTagName(event.target);
    var payload = {
      __ipc_plugin_contextmenu__: true,
      x: _bridgeNumber(event.clientX),
      y: _bridgeNumber(event.clientY),
      screenX: _bridgeNumber(event.screenX),
      screenY: _bridgeNumber(event.screenY),
      tagName: tagName,
      editable: _contextMenuEditable(event.target, tagName),
      selectedText: _contextMenuSelectedText(),
      defaultPrevented: false
    };
    setTimeout(function() {
      payload.defaultPrevented = event.defaultPrevented === true;
      window.parent.postMessage(payload, '*');
    }, 0);
  }
  window.addEventListener('contextmenu', _emitPluginContextMenu, true);
  var _atoolsPluginComposing = false;
  window.addEventListener('compositionstart', function() { _atoolsPluginComposing = true; }, true);
  window.addEventListener('compositionend', function() { _atoolsPluginComposing = false; }, true);
  window.addEventListener('keydown', function(event) {
    if (!event || event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || _atoolsPluginComposing
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    setTimeout(function() {
      if (event.defaultPrevented === true) return;
      window.parent.postMessage({ __ipc_plugin_escape__: true }, '*');
    }, 0);
  });
  function _dbDocId(doc) {
    return doc && typeof doc._id === 'string' ? doc._id : '';
  }
  function _filterDbDocs(docs, opts) {
    var list = Array.isArray(docs) ? docs : [];
    if (Array.isArray(opts)) {
      var byId = {};
      list.forEach(function(doc) {
        var id = _dbDocId(doc);
        if (id) byId[id] = doc;
      });
      return opts.map(function(id) { return byId[String(id)]; }).filter(Boolean);
    }
    if (typeof opts === 'string' && opts.length > 0) {
      return list.filter(function(doc) {
        return _dbDocId(doc).indexOf(opts) === 0;
      });
    }
    return list;
  }
  var _registeredProviders = {};
  function _registerProvider(key, handler) {
`;
export default part;
