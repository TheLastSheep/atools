//! IPC bridge between plugin JavaScript and the Rust host.
//!
//! This module contains:
//!
//! 1. **IPC types** — `IpcCall` and `IpcResult` structs that represent
//!    requests from JS to Rust and responses from Rust to JS.
//!
//! 2. **JavaScript shim** (`SHIM_JS`) — A JavaScript snippet evaluated inside
//!    every plugin context that installs the `utools` global object. The shim
//!    wraps all `utools.*` methods as thin wrappers around a native function
//!    `____IPC____(method, ...args)` that returns a JS `Promise`.
//!
//! ## IPC Flow
//!
//! When a plugin calls `utools.db.put(doc)`, the shim:
//! 1. JSON-encodes the arguments via `JSON.stringify([doc])`
//! 2. Calls `new Promise((resolve, reject) => { callReqId(____IPC____(method, args), resolve, reject) })`
//! 3. The native `____IPC____` function enqueues an `IpcCall` to the dispatcher
//!    and returns a `reqId` string.
//! 4. `callReqId` stores `{ resolve, reject }` in `____pending____[reqId]`.
//! 5. When the dispatcher replies, Rust calls `____resolve____(reqId, json)` or
//!    `____reject____(reqId, error)` which invokes the stored callbacks.

use serde::{Deserialize, Serialize};

/// A single IPC call from the worker thread to the IPC dispatcher thread.
///
/// Constructed by the worker when `____IPC____(method, ...args)` is invoked
/// inside a plugin's JS context, and sent to the dispatcher for processing.
#[derive(Debug)]
pub struct IpcCall {
    /// The plugin that originated this call.
    pub plugin_id: String,

    /// The IPC method name (e.g. `"db.put"`, `"features.set"`).
    pub method: String,

    /// Serialized arguments — every JS value is JSON-encoded by the shim.
    pub args: Vec<serde_json::Value>,

    /// Unique request ID used to correlate the response back to the JS Promise.
    pub req_id: u64,
}

/// Result of an IPC call from the dispatcher back to the worker thread.
///
/// Sent through the callback channel to resolve or reject the JS Promise
/// that was returned to the plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResult {
    /// Whether the call succeeded.
    pub success: bool,

    /// The result value (JSON-encoded) on success, or error message on failure.
    pub value: serde_json::Value,
}

impl IpcResult {
    /// Creates a successful result with a JSON value.
    pub fn success(value: serde_json::Value) -> Self {
        Self {
            success: true,
            value,
        }
    }

    /// Creates a failed result with an error message.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            value: serde_json::Value::String(message.into()),
        }
    }
}

/// The JavaScript shim evaluated inside every plugin context.
///
/// This IIFE:
/// - Verifies that `____IPC____` (the native Rust function) is defined
/// - Sets up `____pending____`, `____nextReqId____`, `callReqId`,
///   `____resolve____`, `____reject____` for Promise-based IPC
/// - Defines `globalThis.utools` with the full uTools API surface
/// - Exposes `____emit____`, `____on____`, `____once____` for lifecycle events
pub const SHIM_JS: &str = r#"(function() {
    'use strict';

    if (typeof globalThis.____IPC____ !== 'function') {
        throw new Error('____IPC____ not defined - runtime error');
    }

    // ---- IPC infrastructure ----
    // Maps reqId -> { resolve, reject } for pending Promise callbacks.
    var ____pending____ = {};
    var ____nextReqId____ = 1;

    globalThis.callReqId = function(reqId, resolve, reject) {
        ____pending____[reqId] = { resolve: resolve, reject: reject };
    };

    globalThis.____resolve____ = function(reqId, jsonStr) {
        var h = ____pending____[reqId];
        if (h) { delete ____pending____[reqId]; try { h.resolve(JSON.parse(jsonStr)); } catch(e) { h.resolve(jsonStr); } }
    };

    globalThis.____reject____ = function(reqId, jsonStr) {
        var h = ____pending____[reqId];
        if (h) { delete ____pending____[reqId]; try { h.reject(JSON.parse(jsonStr)); } catch(e) { h.reject(jsonStr); } }
    };

    // ---- Helpers ----
    function toJson(val) {
        try { return JSON.stringify(val); } catch (e) { return JSON.stringify(String(val)); }
    }

    var pluginId = globalThis.____pluginId____ || '';

    // Internal event system for lifecycle callbacks
    var listeners = {};
    function _on(event, cb) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
    }
    function _emit(event) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cbs = listeners[event] || [];
        cbs.forEach(function(cb) { try { cb.apply(null, args); } catch(e) { console.error('[utools] ' + event + ' listener error:', e); } });
    }
    function _once(event, cb) {
        var wrapper = function() { cb.apply(null, arguments); var idx = listeners[event].indexOf(wrapper); if (idx !== -1) listeners[event].splice(idx, 1); };
        _on(event, wrapper);
    }

    // ipc(method, argsJsonString) — calls native function, returns Promise
    function ipc(method, argsJson) {
        return new Promise(function(resolve, reject) {
            // ____IPC____ enqueues the request and returns the reqId synchronously
            var reqId = globalThis.____IPC____(method, argsJson);
            // Register resolve/reject for this reqId
            globalThis.callReqId(reqId, resolve, reject);
        });
    }
    function ipcWithCallback(method, argsJson, callback) {
        return ipc(method, argsJson).then(function(result) {
            if (typeof callback === 'function') callback(result);
            return result;
        });
    }
    function copiedFileName(path) {
        var raw = String(path || '');
        var trimmed = raw.replace(/[\\/]+$/, '');
        var parts = trimmed.split(/[\\/]/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : raw;
    }
    function normalizeCopiedFileEntry(entry) {
        var record = entry && typeof entry === 'object' ? entry : {};
        var path = typeof entry === 'string'
            ? entry
            : (typeof record.path === 'string' ? record.path : (typeof record.name === 'string' ? record.name : ''));
        var isDiractory = typeof record.isDiractory === 'boolean' ? record.isDiractory : /[\\/]$/.test(path);
        var isFile = typeof record.isFile === 'boolean' ? record.isFile : !isDiractory;
        return Object.assign({}, record, {
            path: path,
            name: typeof record.name === 'string' && record.name ? record.name : copiedFileName(path),
            isFile: isFile,
            isDiractory: isDiractory
        });
    }
    function normalizeCopiedFiles(files) {
        if (!Array.isArray(files)) return [];
        return files.map(normalizeCopiedFileEntry).filter(function(file) {
            return Boolean(file.path);
        });
    }

    globalThis.__atools_registered_tools__ = globalThis.__atools_registered_tools__ || {};
    function normalizeToolName(value) {
        return String(value || '')
            .trim()
            .replace(/[^a-zA-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
    }
    function findAgentToolHandler(name, normalizedName) {
        var registry = globalThis.__atools_registered_tools__ || {};
        var candidates = [String(name || ''), String(normalizedName || ''), normalizeToolName(name)];
        for (var i = 0; i < candidates.length; i += 1) {
            var candidate = candidates[i];
            if (candidate && registry[candidate] && typeof registry[candidate].handler === 'function') {
                return registry[candidate].handler;
            }
        }
        var keys = Object.keys(registry);
        for (var k = 0; k < keys.length; k += 1) {
            var entry = registry[keys[k]];
            if (entry && typeof entry.handler === 'function' && normalizeToolName(keys[k]) === normalizeToolName(name)) {
                return entry.handler;
            }
        }
        var agentTools = globalThis.agentTools || globalThis.__atools_agent_tools__ || {};
        for (var j = 0; j < candidates.length; j += 1) {
            var toolCandidate = candidates[j];
            if (toolCandidate && typeof agentTools[toolCandidate] === 'function') {
                return agentTools[toolCandidate];
            }
        }
        var agentToolKeys = Object.keys(agentTools);
        for (var a = 0; a < agentToolKeys.length; a += 1) {
            var agentToolKey = agentToolKeys[a];
            if (typeof agentTools[agentToolKey] === 'function' && normalizeToolName(agentToolKey) === normalizeToolName(name)) {
                return agentTools[agentToolKey];
            }
        }
        return null;
    }
    var ____asyncAgentToolResults____ = globalThis.____asyncAgentToolResults____ || {};
    var ____nextAsyncAgentToolId____ = globalThis.____nextAsyncAgentToolId____ || 1;
    globalThis.____asyncAgentToolResults____ = ____asyncAgentToolResults____;
    function asyncErrorMessage(error) {
        if (error && typeof error.message === 'string') return error.message;
        try { return String(error); } catch (e) { return 'Unknown async plugin Agent tool error'; }
    }
    function trackAsyncAgentToolResult(thenable) {
        var id = String(____nextAsyncAgentToolId____++);
        globalThis.____nextAsyncAgentToolId____ = ____nextAsyncAgentToolId____;
        ____asyncAgentToolResults____[id] = { status: 'pending' };
        Promise.resolve(thenable).then(function(value) {
            ____asyncAgentToolResults____[id] = {
                status: 'resolved',
                value: value === undefined ? null : value
            };
        }, function(error) {
            ____asyncAgentToolResults____[id] = {
                status: 'rejected',
                error: asyncErrorMessage(error)
            };
        });
        return { __atoolsAsyncAgentToolResultId: id };
    }
    globalThis.____takeAsyncAgentToolResult____ = function(id) {
        var key = String(id || '');
        var result = ____asyncAgentToolResults____[key];
        if (!result) {
            return { status: 'missing', error: 'Async plugin Agent tool result not found: ' + key };
        }
        if (result.status === 'pending') {
            return { status: 'pending' };
        }
        delete ____asyncAgentToolResults____[key];
        return result;
    };
    globalThis.____callAgentTool____ = function(callArgs) {
        var payload = Array.isArray(callArgs) ? (callArgs[0] || {}) : (callArgs || {});
        var name = payload.tool || payload.name || payload.normalizedTool;
        var handler = findAgentToolHandler(name, payload.normalizedTool);
        if (typeof handler !== 'function') {
            throw new Error('Agent tool handler not registered: ' + String(name || ''));
        }
        var result = handler(payload.arguments || {}, payload);
        if (result && typeof result.then === 'function') {
            return trackAsyncAgentToolResult(result);
        }
        return result === undefined ? null : result;
    };

    globalThis.__atools_registered_providers__ = globalThis.__atools_registered_providers__ || {};
    globalThis.____callProvider____ = function(callArgs) {
        var payload = Array.isArray(callArgs) ? (callArgs[0] || {}) : (callArgs || {});
        var key = String(payload.key || '');
        var handler = globalThis.__atools_registered_providers__[key];
        if (typeof handler !== 'function') {
            throw new Error('Provider handler not registered: ' + key);
        }
        var result = handler(payload.input || {});
        if (result && typeof result.then === 'function') {
            return trackAsyncAgentToolResult(result);
        }
        return result === undefined ? null : result;
    };

    if (typeof globalThis.fetch !== 'function') {
        globalThis.fetch = function(url, options) {
            return ipc('network.fetch', toJson([String(url || ''), options || {}])).then(function(response) {
                var body = String(response && response.body || '');
                return {
                    ok: response && response.ok === true,
                    status: Number(response && response.status || 0),
                    statusText: String(response && response.statusText || ''),
                    url: String(response && response.url || url || ''),
                    headers: response && response.headers || {},
                    text: function() { return Promise.resolve(body); },
                    json: function() { return Promise.resolve(JSON.parse(body)); }
                };
            });
        };
    }

    // ---- utools global API ----
    globalThis.utools = {
        // Lifecycle hooks
        onPluginEnter: function(cb) { _on('pluginEnter', cb); },
        onPluginReady: function(cb) { _on('pluginReady', cb); },
        onPluginOut: function(cb) { _on('pluginOut', cb); },
        onPluginDetach: function(cb) { _on('pluginDetach', cb); },
        onDbPull: function(cb) { _on('dbPull', cb); },
        onMainPush: function(callback, onSelect) {
            _on('mainPush', callback);
            if (typeof onSelect === 'function') _on('mainPushSelect', onSelect);
        },
        onMainInput: function(cb) { _on('mainInput', cb); },
        onSubInput: function(cb) { _on('subInput', cb); },
        onSubInputChange: function(cb) { _on('subInputChange', cb); },

        // Database operations (scoped to plugin by the handler)
        db: {
            put: function(doc) { return ipc('db.put', toJson([doc])); },
            get: function(id) { return ipc('db.get', toJson([id])); },
            remove: function(doc) { return ipc('db.remove', toJson([doc])); },
            allDocs: function(opts) { return ipc('db.allDocs', toJson([opts || {}])); },
            bulkDocs: function(docs) { return ipc('db.bulkDocs', toJson([docs])); },
            putAttachment: function(docId, rev, name, data, type) {
                return ipc('db.putAttachment', toJson([docId, rev, name, data, type]));
            },
            getAttachment: function(docId, name) {
                return ipc('db.getAttachment', toJson([docId, name]));
            },
            removeAttachment: function(docId, name, rev) {
                return ipc('db.removeAttachment', toJson([docId, name, rev]));
            }
        },

        // Key-value storage
        dbStorage: {
            setItem: function(key, value) { return ipc('storage.set', toJson([key, value])); },
            getItem: function(key) { return ipc('storage.get', toJson([key])); },
            removeItem: function(key) { return ipc('storage.remove', toJson([key])); }
        },

        // Clipboard
        copyText: function(text) { return ipc('clipboard.copyText', toJson([text])); },
        copyImage: function(img) { return ipc('clipboard.copyImage', toJson([img])); },
        copyFile: function(file) { return ipc('clipboard.copyFile', toJson([file])); },
        readText: function() { return ipc('clipboard.readText', '[]'); },
        readImage: function() { return ipc('clipboard.readImage', '[]'); },
        getCopyedFiles: function() { return ipc('clipboard.getCopyedFiles', '[]').then(normalizeCopiedFiles); },
        getCopiedFiles: function() { return ipc('clipboard.getCopyedFiles', '[]').then(normalizeCopiedFiles); },

        // Input helpers
        setSubInput: function(opts) { return ipc('input.setSubInput', toJson([opts])); },
        removeSubInput: function(placeholder) { return ipc('input.removeSubInput', toJson([placeholder])); },
        setSubInputValue: function(val) { return ipc('input.setSubInputValue', toJson([val])); },
        hideMainWindowPasteText: function(text) { return ipc('input.pasteText', toJson([text])); },
        hideMainWindowPasteImage: function(img) { return ipc('input.pasteImage', toJson([img])); },
        hideMainWindowPasteFile: function(file) { return ipc('input.pasteFile', toJson([file])); },
        hideMainWindowTypeString: function(text) { return ipc('input.typeString', toJson([text])); },

        // System
        showNotification: function(body, clickFeat) { return ipc('system.notify', toJson([body, clickFeat])); },
        shellOpenPath: function(path) { return ipc('shell.openPath', toJson([path])); },
        shellOpenExternal: function(url) { return ipc('shell.openExternal', toJson([url])); },
        shellTrashItem: function(path) { return ipc('shell.trashItem', toJson([path])); },
        shellBeep: function() { return ipc('shell.beep', '[]'); },
        getPath: function(type) { return ipc('system.getPath', toJson([type])); },
        getFileIcon: function(filePath) { return ipc('system.getFileIcon', toJson([filePath])); },

        // User
        getUser: function() { return null; },
        fetchUserServerTemporaryToken: function() {
            return Promise.reject(new Error('fetchUserServerTemporaryToken unsupported: user server temporary token is not available in the current local-only host'));
        },

        // Dialogs
        showOpenDialog: function(opts) { return ipc('dialog.open', toJson([opts])); },
        showSaveDialog: function(opts) { return ipc('dialog.save', toJson([opts])); },

        // Features
        setFeature: function(feature) { return ipc('features.set', toJson([feature])); },
        getFeature: function(code) { return ipc('features.get', toJson([code])); },
        removeFeature: function(code) { return ipc('features.remove', toJson([code])); },
        redirectHotKeySetting: function(cmdLabel, autocopy) { return ipc('settings.redirectHotKey', toJson([cmdLabel, autocopy === true])); },
        redirectAiModelsSetting: function() { return ipc('settings.redirectAiModels', '[]'); },

        // Window control
        showMainWindow: function() { return ipc('window.show', '[]'); },
        hideMainWindow: function() { return ipc('window.hide', '[]'); },
        setExpendHeight: function(height) { return ipc('window.setExpendHeight', toJson([height])); },
        startDrag: function(filePath) { return ipc('window.startDrag', toJson([filePath])); },
        isDarkColors: function() { return ipc('window.isDarkColors', '[]'); },
        createBrowserWindow: function(url, options, callback) { return ipc('window.createBrowserWindow', toJson([url, options || {}, typeof callback === 'function'])); },
        sendToParent: function(channel) { return ipc('window.sendToParent', toJson([channel].concat(Array.prototype.slice.call(arguments, 1)))); },

        // Navigation
        redirect: function(label, payload) { return ipc('app.redirect', toJson([label, payload])); },
        outPlugin: function(data) { return ipc('plugin.out', toJson([data || []])); },

        // Screen helpers
        screenCapture: function(callback) { return ipcWithCallback('screen.capture', '[]', callback); },
        screenColorPick: function(callback) { return ipcWithCallback('screen.colorPick', '[]', callback); },
        desktopCaptureSources: function(options) { return ipc('screen.desktopCaptureSources', toJson([options || {}])); },

        // Agent tool registration. The Rust host discovers manifest-declared
        // tools first; this keeps runtime registration available for plugins
        // that expect the ZTools API shape.
        registerTool: function(name, definition, handler) {
            if (typeof name === 'object' && name) {
                handler = definition;
                definition = name;
                name = definition.name || definition.id || definition.title;
            }
            if (!name) {
                throw new Error('registerTool requires a tool name');
            }
            globalThis.__atools_registered_tools__[String(name)] = {
                name: String(name),
                definition: definition || {},
                handler: typeof handler === 'function' ? handler : null
            };
            return true;
        },

        registerProvider: function(key, handler) {
            key = String(key || '').trim();
            if (!key || typeof handler !== 'function') {
                throw new Error('registerProvider requires a declared key and handler');
            }
            var declaredKeys = globalThis.__atools_declared_provider_keys__;
            if (Array.isArray(declaredKeys) && declaredKeys.indexOf(key) < 0) {
                throw new Error('Provider is not declared in plugin.json: ' + key);
            }
            if (globalThis.__atools_registered_providers__[key]) {
                throw new Error('Provider already registered: ' + key);
            }
            globalThis.__atools_registered_providers__[key] = handler;
            return true;
        },
        providers: {
            getProviders: function(type) { return ipc('providers.getProviders', toJson([type])); },
            getDefaultProvider: function(type) { return ipc('providers.getDefault', toJson([type])); },
            setDefaultProvider: function(type, providerId) { return ipc('providers.setDefault', toJson([type, providerId])); },
            invokeProvider: function(type, input, providerId) { return ipc('providers.invoke', toJson([type, input || {}, providerId])); }
        },
        translate: function(text, options) {
            options = options && typeof options === 'object' ? options : {};
            var input = { text: String(text || ''), from: options.from, to: options.to };
            return ipc('providers.invoke', toJson(['translation', input, options.providerId || null]));
        },
        ocr: function(image, options) {
            options = options && typeof options === 'object' ? options : {};
            var input = { image: String(image || ''), lang: options.lang };
            return ipc('providers.invoke', toJson(['ocr', input, options.providerId || null]));
        },

        // Context helpers used by macOS ZTools plugins. Native support is
        // intentionally routed through IPC when implemented by the host.
        readCurrentBrowserUrl: function() { return ipc('context.currentBrowserUrl', '[]'); },
        getCurrentBrowserUrl: function() { return ipc('context.currentBrowserUrl', '[]'); },
        readCurrentFolderPath: function() { return ipc('context.currentFolderPath', '[]'); },
        getPathForFile: function(file) { return ipc('system.getPathForFile', toJson([file])); },

        // Platform detection
        isMacOS: function() { return ipc('system.isMacOS', '[]'); },
        isMacOs: function() { return ipc('system.isMacOS', '[]'); },
        isWindows: function() { return ipc('system.isWindows', '[]'); },
        isLinux: function() { return ipc('system.isLinux', '[]'); },

        // Helpers
        shellShowItem: function(path) { return ipc('shell.showItem', toJson([path])); },
        getNativeId: function() { return ipc('system.nativeId', '[]'); }
    };
    globalThis.utools.db.promises = globalThis.utools.db;
    globalThis.ztools = globalThis.utools;

    // Expose lifecycle helpers for the Rust host
    globalThis.____emit____ = _emit;
    globalThis.____on____ = _on;
    globalThis.____once____ = _once;
})();
"#;

#[cfg(test)]
mod tests {
    use super::SHIM_JS;

    #[test]
    fn shim_exposes_screen_interactive_api_surface() {
        assert!(SHIM_JS.contains("screenCapture: function(callback)"));
        assert!(SHIM_JS.contains("screenColorPick: function(callback)"));
        assert!(SHIM_JS.contains("desktopCaptureSources: function(options)"));
        assert!(SHIM_JS.contains("screen.colorPick"));
        assert!(SHIM_JS.contains("screen.desktopCaptureSources"));
    }

    #[test]
    fn shim_exposes_external_input_api_surface() {
        assert!(SHIM_JS.contains("hideMainWindowPasteText: function(text)"));
        assert!(SHIM_JS.contains("hideMainWindowPasteImage: function(img)"));
        assert!(SHIM_JS.contains("hideMainWindowPasteFile: function(file)"));
        assert!(SHIM_JS.contains("hideMainWindowTypeString: function(text)"));
        assert!(SHIM_JS.contains("input.pasteText"));
        assert!(SHIM_JS.contains("input.pasteImage"));
        assert!(SHIM_JS.contains("input.pasteFile"));
        assert!(SHIM_JS.contains("input.typeString"));
    }

    #[test]
    fn shim_exposes_ztools_provider_api_surface() {
        assert!(SHIM_JS.contains("registerProvider: function(key, handler)"));
        assert!(SHIM_JS.contains("getProviders: function(type)"));
        assert!(SHIM_JS.contains("getDefaultProvider: function(type)"));
        assert!(SHIM_JS.contains("invokeProvider: function(type, input, providerId)"));
        assert!(SHIM_JS.contains("translate: function(text, options)"));
        assert!(SHIM_JS.contains("ocr: function(image, options)"));
        assert!(SHIM_JS.contains("globalThis.____callProvider____"));
        assert!(SHIM_JS.contains("ipc('network.fetch'"));
    }

    #[test]
    fn shim_normalizes_copied_file_api_surface() {
        assert!(SHIM_JS.contains("function normalizeCopiedFiles(files)"));
        assert!(SHIM_JS.contains(
            "getCopyedFiles: function() { return ipc('clipboard.getCopyedFiles', '[]').then(normalizeCopiedFiles); }"
        ));
        assert!(SHIM_JS.contains(
            "getCopiedFiles: function() { return ipc('clipboard.getCopyedFiles', '[]').then(normalizeCopiedFiles); }"
        ));
    }

    #[test]
    fn shim_exposes_user_api_surface() {
        assert!(SHIM_JS.contains("getUser: function() { return null; }"));
        assert!(SHIM_JS.contains("fetchUserServerTemporaryToken: function()"));
        assert!(SHIM_JS.contains("fetchUserServerTemporaryToken unsupported"));
    }

    #[test]
    fn shim_exposes_window_drag_api_surface() {
        assert!(SHIM_JS.contains("startDrag: function(filePath)"));
        assert!(SHIM_JS.contains("window.startDrag"));
    }

    #[test]
    fn shim_exposes_window_theme_api_surface() {
        assert!(SHIM_JS.contains("isDarkColors: function()"));
        assert!(SHIM_JS.contains("window.isDarkColors"));
    }

    #[test]
    fn shim_exposes_system_shell_api_surface() {
        assert!(SHIM_JS.contains("getFileIcon: function(filePath)"));
        assert!(SHIM_JS.contains("system.getFileIcon"));
        assert!(SHIM_JS.contains("shellTrashItem: function(path)"));
        assert!(SHIM_JS.contains("shell.trashItem"));
        assert!(SHIM_JS.contains("shellBeep: function()"));
        assert!(SHIM_JS.contains("shell.beep"));
        assert!(SHIM_JS.contains("isMacOS: function()"));
        assert!(SHIM_JS.contains("system.isMacOS"));
        assert!(SHIM_JS.contains("isWindows: function()"));
        assert!(SHIM_JS.contains("system.isWindows"));
        assert!(SHIM_JS.contains("isLinux: function()"));
        assert!(SHIM_JS.contains("system.isLinux"));
    }

    #[test]
    fn shim_exposes_window_browser_api_surface() {
        assert!(SHIM_JS.contains("createBrowserWindow: function(url, options, callback)"));
        assert!(SHIM_JS.contains("sendToParent: function(channel)"));
        assert!(SHIM_JS.contains("window.createBrowserWindow"));
        assert!(SHIM_JS.contains("window.sendToParent"));
    }

    #[test]
    fn shim_exposes_dynamic_settings_redirect_api_surface() {
        assert!(SHIM_JS.contains("redirectHotKeySetting: function(cmdLabel, autocopy)"));
        assert!(SHIM_JS.contains("settings.redirectHotKey"));
        assert!(SHIM_JS.contains("redirectAiModelsSetting: function()"));
        assert!(SHIM_JS.contains("settings.redirectAiModels"));
    }
}
