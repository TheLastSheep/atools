const part = `    var raw = String(path || '');
    var trimmed = raw.replace(/[\\/]+$/, '');
    var parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }
  function _normalizeCopiedFileEntry(entry) {
    var record = entry && typeof entry === 'object' ? entry : {};
    var path = typeof entry === 'string'
      ? entry
      : (typeof record.path === 'string' ? record.path : (typeof record.name === 'string' ? record.name : ''));
    var isDiractory = typeof record.isDiractory === 'boolean' ? record.isDiractory : /[\\/]$/.test(path);
    var isFile = typeof record.isFile === 'boolean' ? record.isFile : !isDiractory;
    return Object.assign({}, record, {
      path: path,
      name: typeof record.name === 'string' && record.name ? record.name : _copiedFileName(path),
      isFile: isFile,
      isDiractory: isDiractory
    });
  }
  function _normalizeCopiedFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.map(_normalizeCopiedFileEntry).filter(function(file) {
      return Boolean(file.path);
    });
  }

  function _attachmentKey(docId, name) {
    return '__attachment__:' + String(docId) + ':' + String(name || 'attachment');
  }

  function _putAttachment(args) {
    var docId = args[0];
    var name = 'attachment';
    var data;
    var contentType;

    if (args.length >= 5) {
      name = args[2];
      data = args[3];
      contentType = args[4];
    } else if (args.length >= 4) {
      name = args[1];
      data = args[2];
      contentType = args[3];
    } else {
      data = args[1];
      contentType = args[2];
    }

    if (!docId) return Promise.reject(new Error('postAttachment missing document id'));
    if (data == null) return Promise.reject(new Error('postAttachment missing data'));

    return _invokeFn("put_plugin_data", {
      pluginId: __PLUGIN_ID__,
      doc: {
        _id: _attachmentKey(docId, name),
        docId: String(docId),
        name: String(name || 'attachment'),
        data: String(data),
        contentType: contentType || 'application/octet-stream'
      }
    }).then(function() {
      return { ok: true, id: String(docId), name: String(name || 'attachment') };
    });
  }

  function _getAttachment(args) {
    var docId = args[0];
    var name = args.length >= 2 ? args[1] : 'attachment';
    if (!docId) return Promise.reject(new Error('getAttachment missing document id'));

    return _invokeFn("get_plugin_data_item", {
      pluginId: __PLUGIN_ID__,
      docId: _attachmentKey(docId, name)
    }).then(function(doc) {
      return doc ? doc.data : null;
    });
  }

  function _getAttachmentType(args) {
    var docId = args[0];
    var name = args.length >= 2 ? args[1] : 'attachment';
    if (!docId) return Promise.reject(new Error('getAttachmentType missing document id'));

    return _invokeFn("get_plugin_data_item", {
      pluginId: __PLUGIN_ID__,
      docId: _attachmentKey(docId, name)
    }).then(function(doc) {
      return doc ? (doc.contentType || 'application/octet-stream') : null;
    });
  }

  var _dbStorageMemory = {};
  function _dbStorageKey(key) {
    return 'atools:dbStorage:' + __PLUGIN_ID__ + ':' + String(key);
  }
  function _dbStorageSetRaw(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch (err) {}
    _dbStorageMemory[key] = value;
  }
  function _dbStorageGetRaw(key) {
    try {
      var stored = window.localStorage.getItem(key);
      if (stored != null) return stored;
    } catch (err) {}
    return Object.prototype.hasOwnProperty.call(_dbStorageMemory, key) ? _dbStorageMemory[key] : null;
  }
  function _dbStorageRemoveRaw(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {}
    delete _dbStorageMemory[key];
  }
  function _dbStorageEncode(value) {
    return JSON.stringify({ value: value });
  }
  function _dbStorageDecode(value) {
    if (value == null) return null;
    try {
      var parsed = JSON.parse(value);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'value')) return parsed.value;
      return parsed;
    } catch (err) {
      return value;
    }
  }
  function _createDbStorage() {
    return {
      setItem: function(key, value) {
        _dbStorageSetRaw(_dbStorageKey(key), _dbStorageEncode(value));
      },
      getItem: function(key) {
        return _dbStorageDecode(_dbStorageGetRaw(_dbStorageKey(key)));
      },
      removeItem: function(key) {
        _dbStorageRemoveRaw(_dbStorageKey(key));
      }
    };
  }

  var _nativeIdMemory = '';
  function _randomNativeId() {
    return 'atools-native-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function _getNativeId() {
    if (_nativeIdMemory) return _nativeIdMemory;
    try {
      var stored = window.localStorage.getItem('atools:nativeId');
      if (stored) {
        _nativeIdMemory = stored;
        return _nativeIdMemory;
      }
      _nativeIdMemory = _randomNativeId();
      window.localStorage.setItem('atools:nativeId', _nativeIdMemory);
      return _nativeIdMemory;
    } catch (err) {
      _nativeIdMemory = _nativeIdMemory || _randomNativeId();
      return _nativeIdMemory;
    }
  }

  function _displayUnavailable() {
    var error = new Error('ERR_ATOOLS_DISPLAY_UNSUPPORTED: native display metadata requires an authorized desktop host');
    error.code = 'ERR_ATOOLS_DISPLAY_UNSUPPORTED';
    throw error;
  }

  // utools/ztools API bridge
`;
export default part;
