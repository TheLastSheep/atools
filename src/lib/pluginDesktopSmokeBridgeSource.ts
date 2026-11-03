import { desktopBrowserWindowIsolationProbeSource } from "./desktopBrowserWindowIsolationProbe";

const PLUGIN_SCRIPT_CLOSE_RE = new RegExp("</" + "script", "gi");

export function pluginBridgeJson(value: unknown) {
return JSON.stringify(value).replace(PLUGIN_SCRIPT_CLOSE_RE, "<\\/script");
}

export function createDesktopSmokeBridgeProbeHtml(options: {
  enabled: boolean;
  pluginId: string;
  featureCode: string;
  sampleIndex: number;
  mainUrl: string;
}) {
  if (!options.enabled) return "";
  const pluginId = pluginBridgeJson(options.pluginId);
  const featureCode = pluginBridgeJson(options.featureCode);
  const sampleIndex = Number.isFinite(options.sampleIndex) ? options.sampleIndex : 0;
  const browserWindowProbeSource = desktopBrowserWindowIsolationProbeSource({
    mainUrl: options.mainUrl || "index.html",
    sampleIndex,
  });
  return `
<script>
(function() {
var pluginId = ${pluginId};
var featureCode = ${featureCode};
var sampleIndex = ${sampleIndex};
function probeResult(id, passed, detail) {
  return {
    id: String(id || 'unknown'),
    passed: passed === true,
    detail: detail == null ? '' : String(detail)
  };
}
function runProbe(id, callback) {
  try {
    return probeResult(id, callback() === true);
  } catch (error) {
    return probeResult(id, false, error && error.message || String(error));
  }
}
function runAsyncProbe(id, callback) {
  return Promise.resolve()
    .then(callback)
    .then(function(passed) {
      return probeResult(id, passed === true);
    })
    .catch(function(error) {
      return probeResult(id, false, error && error.message || String(error));
    });
}
function contextBridgeErrorAccepted(error) {
  return /readCurrentBrowserUrl|readCurrentFolderPath|browser|finder|osascript|automation|permission|unavailable|not available|denied/i.test(String(error && error.message || error || ''));
}
function visibleInputState() {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'));
  for (var i = 0; i < inputs.length; i += 1) {
    var element = inputs[i];
    if (!element || element.disabled === true || element.type === 'hidden') continue;
    var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
    var rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    var visible = !rect || (rect.width > 0 && rect.height > 0);
    if (!visible) continue;
    return {
      visible: true,
      placeholder: String(element.getAttribute('placeholder') || '')
    };
  }
  return { visible: false, placeholder: '' };
}
function run() {
  var key = 'atools-desktop-smoke-bridge-probe-' + sampleIndex;
  var inputState = visibleInputState();
  var probes = [
    runProbe('desktop-bridge-utools-object', function() {
      return !!window.utools && window.ztools === window.utools;
    }),
    runProbe('desktop-bridge-window-type', function() {
      return !!window.utools && typeof window.utools.getWindowType === 'function' && window.utools.getWindowType() === 'main';
    }),
    runProbe('desktop-bridge-app-identity', function() {
      return !!window.utools
        && typeof window.utools.getAppName === 'function'
        && typeof window.utools.getAppVersion === 'function'
        && String(window.utools.getAppName() || '').length > 0
        && String(window.utools.getAppVersion() || '').length > 0;
    }),
    runProbe('desktop-bridge-db-storage', function() {
      if (!window.utools || !window.utools.dbStorage) return false;
      window.utools.dbStorage.setItem(key, { ok: true, sampleIndex: sampleIndex });
      var value = window.utools.dbStorage.getItem(key);
      window.utools.dbStorage.removeItem(key);
      return !!value && value.ok === true && value.sampleIndex === sampleIndex;
    }),
    runProbe('desktop-bridge-platform-flags', function() {
      return !!window.utools
        && typeof window.utools.isDev === 'function'
        && typeof window.utools.isMacOS === 'function'
        && typeof window.utools.isWindows === 'function'
        && typeof window.utools.isLinux === 'function'
        && typeof window.utools.isDev() === 'boolean'
        && typeof window.utools.isMacOS() === 'boolean'
        && typeof window.utools.isWindows() === 'boolean'
        && typeof window.utools.isLinux() === 'boolean';
    })
  ];
  var browserWindowProbePromise = ${browserWindowProbeSource};
  Promise.all([
    Promise.all([
    runAsyncProbe('desktop-bridge-native-get-path', function() {
      return window.utools && typeof window.utools.getPath === 'function'
        ? Promise.resolve(window.utools.getPath('home')).then(function(value) {
            return typeof value === 'string' && value.length > 0;
          })
        : false;
    }),
    runAsyncProbe('desktop-bridge-native-capture-sources', function() {
      return window.utools && typeof window.utools.desktopCaptureSources === 'function'
        ? Promise.resolve(window.utools.desktopCaptureSources({ types: ['screen'] })).then(function(sources) {
            return Array.isArray(sources) && sources.length > 0;
          })
        : false;
    }),
    runAsyncProbe('desktop-bridge-native-browser-context', function() {
      if (!window.utools || typeof window.utools.readCurrentBrowserUrl !== 'function') return false;
      return Promise.resolve(window.utools.readCurrentBrowserUrl())
        .then(function(value) {
          return typeof value === 'string' || value === null || value === undefined;
        })
        .catch(function(error) {
          return contextBridgeErrorAccepted(error);
        });
    }),
    runAsyncProbe('desktop-bridge-native-folder-context', function() {
      if (!window.utools || typeof window.utools.readCurrentFolderPath !== 'function') return false;
      return Promise.resolve(window.utools.readCurrentFolderPath())
        .then(function(value) {
          return typeof value === 'string' || value === null || value === undefined;
        })
        .catch(function(error) {
          return contextBridgeErrorAccepted(error);
        });
    })
    ]),
    browserWindowProbePromise
  ]).then(function(results) {
    var nativeMethodProbes = results[0];
    var browserWindowProbe = results[1] && typeof results[1] === 'object' ? results[1] : {};
    var browserWindowProbes = Array.isArray(browserWindowProbe.probes) ? browserWindowProbe.probes : [];
    var browserWindowProbePassed = browserWindowProbe.expected === true
      && browserWindowProbe.reported === true
      && browserWindowProbes.length === 9
      && browserWindowProbes.every(function(probe) { return probe && probe.passed === true; });
    window.__ATOOLS_FRAME_TRANSPORT__.post({
      __atools_desktop_smoke_bridge_probe__: true,
      pluginId: pluginId,
      featureCode: featureCode,
      sampleIndex: sampleIndex,
      probes: probes,
      nativeMethodProbes: nativeMethodProbes,
      browserWindowProbeExpected: browserWindowProbe.expected === true,
      browserWindowProbeReported: browserWindowProbe.reported === true,
      browserWindowProbePassed: browserWindowProbePassed,
      browserWindowProbes: browserWindowProbes,
      browserWindowCreated: browserWindowProbe.created === true,
      browserWindowChildOriginOpaque: browserWindowProbe.childOriginOpaque === true,
      browserWindowSelfTauriUnavailable: browserWindowProbe.selfTauriUnavailable === true,
      browserWindowParentTauriUnavailable: browserWindowProbe.parentTauriUnavailable === true,
      browserWindowParentDocumentBlocked: browserWindowProbe.parentDocumentBlocked === true,
      browserWindowSendToParentChecked: browserWindowProbe.sendToParentChecked === true,
      browserWindowExecuteJavascriptChecked: browserWindowProbe.executeJavascriptChecked === true,
      browserWindowIpcRoundtripChecked: browserWindowProbe.ipcRoundtripChecked === true,
      browserWindowCleanupChecked: browserWindowProbe.cleanupChecked === true,
      domInputVisible: inputState.visible,
      domInputPlaceholder: inputState.placeholder
    }, '*');
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { setTimeout(run, 0); }, { once: true });
} else {
  setTimeout(run, 0);
}
})();
<\/script>`;
}


