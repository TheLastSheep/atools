import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { offlineNodePolicySource } from "../../../scripts/lib/ztools-matrix-offline-policy.mjs";
import { createOfficeCliProcessPolicySource, isValidatedOfficeCliFixture } from "./office-cli-policy.mjs";

const FIXTURE_ENV_KEYS = new Set([
  "PATH", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "HOME", "USERPROFILE", "HOMEPATH", "HOMEDRIVE",
  "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
]);

function failure(message) {
  return Object.assign(new Error(message), { code: "ERR_ATOOLS_ORIGINAL_PLUGIN_FIXTURE" });
}

function absoluteRoot(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw failure(`${label} must be an absolute fixture path`);
  }
  return value;
}

export function normalizeOriginalPluginFixtureEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("fixtureEnv must come from createFixtureEnvironment()");
  }
  const env = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!FIXTURE_ENV_KEYS.has(key) || typeof item !== "string") {
      throw failure("fixtureEnv contains a non-fixture or non-string environment entry");
    }
    env[key] = item;
  }
  if (typeof env.PATH !== "string" || !env.PATH) throw failure("fixtureEnv.PATH must be provided");
  for (const key of ["HOME", "XDG_DATA_HOME", "TMPDIR"]) absoluteRoot(env[key], `fixtureEnv.${key}`);
  return env;
}

export function originalPluginDiagnosticPrefix(pluginId) {
  if (pluginId === "live-markdown") return "ATLM";
  if (pluginId === "format-converter") return "ATFC";
  throw failure("pluginId must be live-markdown or format-converter");
}

function networkObservationSource(pluginId) {
  const marker = originalPluginDiagnosticPrefix(pluginId);
  return `;(function(){
const net = require('node:net');
function note(kind) { process.stderr.write('${marker}_DENIAL ' + JSON.stringify({ pluginId: '${pluginId}', kind }) + '\\n'); }
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  try { return Reflect.apply(connect, this, args); }
  catch (error) { if (error && error.code === 'ERR_MATRIX_OFFLINE_NETWORK') note('externalNetwork'); throw error; }
};
const fetch = globalThis.fetch;
if (fetch) globalThis.fetch = function(...args) {
  let result;
  try { result = Reflect.apply(fetch, this, args); }
  catch (error) { if (error && error.code === 'ERR_MATRIX_OFFLINE_NETWORK') note('externalNetwork'); throw error; }
  return Promise.resolve(result).catch(error => {
    if (error && error.code === 'ERR_MATRIX_OFFLINE_NETWORK') note('externalNetwork');
    throw error;
  });
};
})();
`;
}

export function originalPluginNodeOperationsPolicySource(pluginId, officeCli) {
  const marker = originalPluginDiagnosticPrefix(pluginId);
  const officeCliRuntimeSource = officeCli ? createOfficeCliProcessPolicySource(officeCli, marker) : "null";
  return `;(function(){
const Module = require('node:module');
const net = require('node:net');
const load = Module._load;
const officeCliRuntime = ${officeCliRuntimeSource};
const guardedChildProcessModules = new WeakMap();
const dnsMethods = new Set(['lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname',
  'resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTlsa','resolveTxt','reverse']);
const dgramMethods = new Set(['bind','connect','send','addMembership','dropMembership','addSourceSpecificMembership',
  'dropSourceSpecificMembership']);
function deny(method) {
  return function() {
    process.stderr.write('${marker}_DENIAL ' + JSON.stringify({ pluginId: '${pluginId}', kind: 'childProcess' }) + '\\n');
    const error = new Error('ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED: ' + String(method));
    error.code = 'ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED';
    throw error;
  };
}
function denyNetwork(method) {
  return function() {
    process.stderr.write('${marker}_DENIAL ' + JSON.stringify({ pluginId: '${pluginId}', kind: 'externalNetwork' }) + '\\n');
    const error = new Error('ERR_ATOOLS_FIXTURE_EXTERNAL_NETWORK_DENIED: ' + String(method));
    error.code = 'ERR_ATOOLS_FIXTURE_EXTERNAL_NETWORK_DENIED';
    throw error;
  };
}
function guardChildProcess(target, label) {
  if (officeCliRuntime && (label === 'node:child_process' || label === 'child_process')) {
    return officeCliRuntime.guardChildProcess(target, label, deny);
  }
  let byLabel = guardedChildProcessModules.get(target);
  if (!byLabel) { byLabel = new Map(); guardedChildProcessModules.set(target, byLabel); }
  if (byLabel.has(label)) return byLabel.get(label);
  const functionCache = new Map();
  const getterCache = new Map();
  function secureValue(key, value) {
    if (key === 'promises' && value && typeof value === 'object') return guardChildProcess(value, label + '.promises');
    if (typeof value !== 'function') return value;
    const cached = functionCache.get(key);
    if (cached && cached.original === value) return cached.wrapper;
    const wrapper = (...args) => deny(label + '.' + String(key))();
    functionCache.set(key, { original: value, wrapper });
    return wrapper;
  }
  function safeDescriptor(object, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return descriptor;
    if ('value' in descriptor) {
      const value = secureValue(key, descriptor.value);
      if (value === descriptor.value) return descriptor;
      if (descriptor.configurable || descriptor.writable) return { ...descriptor, value };
      throw new TypeError('Cannot safely wrap fixed child_process export: ' + String(key));
    }
    if (typeof descriptor.get === 'function') {
      if (!descriptor.configurable) throw new TypeError('Cannot safely wrap fixed child_process accessor: ' + String(key));
      const cached = getterCache.get(key);
      const getter = cached && cached.original === descriptor.get ? cached.wrapper : function() {
        return secureValue(key, Reflect.apply(descriptor.get, target, []));
      };
      getterCache.set(key, { original: descriptor.get, wrapper: getter });
      return { ...descriptor, get: getter };
    }
    return descriptor;
  }
  const proxy = new Proxy(target, {
    get(object, key) { return secureValue(key, Reflect.get(object, key, object)); },
    getOwnPropertyDescriptor: safeDescriptor,
  });
  byLabel.set(label, proxy);
  return proxy;
}
if (officeCliRuntime) {
  officeCliRuntime.guardProcessKill(deny);
  officeCliRuntime.guardBuiltinModule(guardChildProcess, deny);
}
function guardDnsResolver(Resolver, label) {
  return new Proxy(Resolver, { construct(target, args, newTarget) {
    const resolver = Reflect.construct(target, args, newTarget);
    return guardDns(resolver, label);
  } });
}
function guardDns(target, label) {
  return new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key, object);
    if (key === 'promises' && value && typeof value === 'object') return guardDns(value, label + '.promises');
    if (key === 'Resolver' && typeof value === 'function') return guardDnsResolver(value, label + '.Resolver');
    if (typeof value !== 'function') return value;
    if (key === 'lookup') return function(hostname, ...args) {
      if (typeof hostname === 'string' && net.isIP(hostname)) return Reflect.apply(value, object, [hostname, ...args]);
      return denyNetwork(label + '.lookup')();
    };
    if (dnsMethods.has(String(key))) return denyNetwork(label + '.' + String(key));
    return value;
  } });
}
function guardDgramSocket(Socket, label) {
  return new Proxy(Socket, { construct(target, args, newTarget) {
    const socket = Reflect.construct(target, args, newTarget);
    return new Proxy(socket, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (dgramMethods.has(String(key)) && typeof value === 'function') return denyNetwork(label + '.' + String(key));
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  } });
}
function guardDgram(target, label) {
  return new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key, object);
    if (key === 'createSocket' && typeof value === 'function') return denyNetwork(label + '.createSocket');
    if (key === 'Socket' && typeof value === 'function') return guardDgramSocket(value, label + '.Socket');
    return value;
  } });
}
Module._load = function(request, parent, isMain) {
  const result = Reflect.apply(load, this, [request, parent, isMain]);
  const specifier = String(request);
  if (/^(?:node:)?child_process(?:\\/|$)/.test(specifier)) return guardChildProcess(result, specifier);
  if (/^(?:node:)?dns$/.test(specifier) || /^(?:node:)?dns\\/promises$/.test(specifier)) return guardDns(result, specifier);
  if (/^(?:node:)?dgram$/.test(specifier)) return guardDgram(result, specifier);
  return result;
};
})();
`;
}

/** Uses exact production Node policy, codec, bounded path readers and bootstrap bytes. */
export async function createOriginalPluginNodeLaunch({ pluginId, root, pluginRoot, preloadPath, scratchRoot,
  pluginDataRoot, fixtureEnv, officeCli }) {
  originalPluginDiagnosticPrefix(pluginId);
  if (officeCli && (pluginId !== "format-converter" || !isValidatedOfficeCliFixture(officeCli))) {
    throw failure("officeCli launch permission requires a validated Format Converter policy");
  }
  const sourceFiles = [
    "crates/atools-plugin/src/legacy_node/codec.cjs",
    "crates/atools-plugin/src/legacy_node/bounded_png_path.cjs",
    "crates/atools-plugin/src/legacy_node/bounded_native_image_path.cjs",
    "crates/atools-plugin/src/legacy_node/managed_child_transport.cjs",
    "crates/atools-plugin/src/legacy_node/managed_child_streams.cjs",
    "crates/atools-plugin/src/legacy_node/managed_children.cjs",
    "crates/atools-plugin/src/legacy_node/bootstrap.cjs",
  ];
  const sourceBytes = await Promise.all(sourceFiles.map(path => readFile(join(root, path))));
  const bootstrap = Buffer.concat([
    Buffer.from(await offlineNodePolicySource(), "utf8"),
    Buffer.from(networkObservationSource(pluginId), "utf8"),
    Buffer.from(originalPluginNodeOperationsPolicySource(pluginId, officeCli), "utf8"),
    ...sourceBytes.flatMap(bytes => [bytes, Buffer.from("\n")]),
  ]);
  const env = Object.fromEntries(Object.entries(fixtureEnv));
  env.ATOOLS_PLUGIN_ID = pluginId;
  env.ATOOLS_PLUGIN_DIR = pluginRoot;
  env.ATOOLS_PRELOAD_ENTRY = preloadPath;
  return {
    nodeBinary: join(root, "src-tauri/binaries/node-aarch64-apple-darwin"),
    args: [
      "--permission",
      ...(officeCli ? ["--allow-child-process"] : []),
      `--allow-fs-read=${pluginRoot}`,
      `--allow-fs-read=${fixtureEnv.HOME}`,
      `--allow-fs-read=${fixtureEnv.XDG_DATA_HOME}`,
      `--allow-fs-write=${scratchRoot}`,
      `--allow-fs-write=${pluginDataRoot}`,
      "-e", bootstrap.toString("utf8"),
    ],
    env,
  };
}
