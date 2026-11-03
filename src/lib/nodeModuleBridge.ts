import { createNodeModuleTransport } from "./nodeModuleTransport";
import { createNodeModuleCodec, nodeModuleCodecScript } from "./nodeModuleValues";
import { createNodeModulePayloadBudget } from "./nodeModulePayloadBudget";
import { createNodeNativeFilesystem } from "./nodeNativeFilesystem";
import { createNodeFsFileHandleAdapters } from "./nodeFsFileHandles";
import { createNodePromisePolling } from "./nodePromisePolling";
import type {
  EncodedNodeValue, NodeHandleDescriptor, NodeModuleRequire, NodeModuleSessionConfig,
  NodeModuleTransport, NodePollResult,
} from "./nodeModuleProtocol";

export type { NodeModuleRequire, NodeModuleSessionConfig, NodeModuleTransport } from "./nodeModuleProtocol";

/**
 * Keep preload and UI closures local. Remote callbacks are notifications, never
 * synchronous predicates. Property writes reach Node, except callback/function
 * assignments; prototype/instanceof reflection is outside this protocol.
 * Call close() when the plugin generation ends.
 */
export function makeNodeModuleRequire(
  config: NodeModuleSessionConfig,
  transport = createNodeModuleTransport(config),
): NodeModuleRequire {
  return createNodeModuleRequireRuntime(
    transport,
    createNodeModuleCodec,
    createNodeModulePayloadBudget,
    createNodeNativeFilesystem,
    createNodeFsFileHandleAdapters,
    createNodePromisePolling,
  );
}

/** JavaScript expression suitable for assignment to window.require in an opaque frame. */
export function nodeModuleBridgeScript(config: NodeModuleSessionConfig): string {
  const encodedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
  const budgetFactory = `(${createNodeModulePayloadBudget.toString()})`;
  const fileHandleFactory = `(${createNodeFsFileHandleAdapters.toString()})`;
  const promisePollingFactory = `(${createNodePromisePolling.toString()})`;
  return `((budgetFactory,fileHandleFactory,promisePollingFactory)=>(${createNodeModuleRequireRuntime.toString()})((${createNodeModuleTransport.toString()})(${encodedConfig},budgetFactory),${nodeModuleCodecScript("budgetFactory")},budgetFactory,(${createNodeNativeFilesystem.toString()}),fileHandleFactory,promisePollingFactory))(${budgetFactory},${fileHandleFactory},${promisePollingFactory})`;
}

/** Keep this runtime self-contained: its source is serialized after build/minification. */
function createNodeModuleRequireRuntime(
  transport: NodeModuleTransport,
  createCodec: typeof createNodeModuleCodec,
  createPayloadBudget: typeof createNodeModulePayloadBudget = createNodeModulePayloadBudget,
  createNativeFilesystem: typeof createNodeNativeFilesystem = createNodeNativeFilesystem,
  createFileHandleAdapters: typeof createNodeFsFileHandleAdapters,
  createPromisePolling: typeof createNodePromisePolling,
): NodeModuleRequire {
  type Callback = { fn: Function; references: number };
  type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; callbackIds: string[] };
  type Reference<T extends object> = { deref: () => T | undefined };
  const modules = new Map<string, unknown>();
  const handles = new Map<number, { reference: Reference<object>; descriptor: NodeHandleDescriptor }>();
  const handleDescriptors = new WeakMap<object, NodeHandleDescriptor>();
  const promises = new Map<number, Reference<Promise<unknown>>>();
  const pending = new Map<number, Pending>();
  const callbacks = new Map<string, Callback>();
  const callbackIds = new WeakMap<Function, string>();
  const unsubscribeCallbacks = new Map<number, string[]>();
  const localRequire = (globalThis as any).window?.require;
  let nextCallbackId = 0;
  let collectingCallbacks: Set<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let draining = false;
  let emptyPolls = 0;
  let closed = false;
  const garbage = new Set<number>();
  const canCollect = typeof WeakRef === "function" && typeof FinalizationRegistry === "function";
  const finalizer = canCollect ? new FinalizationRegistry<number>((handleId) => {
    // A new proxy may have acquired the same remote identity before an older
    // proxy's finalizer runs. Never revoke that live replacement.
    if (closed || handles.get(handleId)?.reference.deref() || promises.get(handleId)?.deref()) return;
    handles.delete(handleId); promises.delete(handleId);
    if (unsubscribeCallbacks.get(handleId)?.every((id) => !callbacks.has(id))) unsubscribeCallbacks.delete(handleId);
    garbage.add(handleId);
  }) : undefined;
  function reference<T extends object>(value: T, handleId: number): Reference<T> {
    garbage.delete(handleId);
    if (!canCollect) return { deref: () => value };
    finalizer!.register(value, handleId);
    return new WeakRef(value);
  }
  const rawTransport = transport;
  function collectGarbage() {
    // Queued callback descriptors must remain valid until their subscription is
    // drained/released. Defer reclamation during async work, without idle timers.
    if (closed || callbacks.size || pending.size || !garbage.size) return;
    const ids = [...garbage];
    try {
      for (let offset = 0; offset < ids.length; offset += 4096) {
        rawTransport.requestSync("release", { handleIds: ids.slice(offset, offset + 4096), callbackIds: [] });
        for (const id of ids.slice(offset, offset + 4096)) { garbage.delete(id); unsubscribeCallbacks.delete(id); }
      }
    } catch (error) {
      close(error instanceof Error ? error : bridgeError(String(error)));
      throw error;
    }
  }
  transport = {
    requestSync(method, params) { if (method !== "release") collectGarbage(); return rawTransport.requestSync(method, params); },
    requestAsync(method, params) { if (method !== "release") collectGarbage(); return rawTransport.requestAsync(method, params); },
  };
  const pollPromiseStates = createPromisePolling(transport.requestAsync, () => !closed);

  function bridgeError(message: string, code = "ERR_ATOOLS_NODE_BRIDGE"): Error {
    const error = new Error(message) as Error & { code: string };
    error.name = "NodeModuleBridgeError";
    error.code = code;
    return error;
  }

  function assertOpen() {
    if (closed) throw bridgeError("Node module session is closed", "ERR_ATOOLS_NODE_SESSION_CLOSED");
  }

  function forgetCallbacks(ids: Iterable<string>, force = false) {
    const released: string[] = [];
    for (const id of ids) {
      const callback = callbacks.get(id);
      if (!callback) continue;
      callback.references -= 1;
      if (force || callback.references <= 0) {
        callbacks.delete(id);
        callbackIds.delete(callback.fn);
        released.push(id);
      }
    }
    if (!callbacks.size && !pending.size && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Release synchronously so a subsequent call cannot race ahead and exhaust
    // the remote callback quota while cleanup is still in flight.
    if (released.length && !closed) {
      try { transport.requestSync("release", { handleIds: [], callbackIds: released }); }
      catch (error) {
        console.error("[ATools Node module bridge] callback release failed", error);
        close(error instanceof Error ? error : bridgeError(String(error)));
      }
    }
  }

  function registerCallback(fn: Function): string {
    let id = callbackIds.get(fn);
    if (!id) {
      id = `callback-${++nextCallbackId}`;
      callbackIds.set(fn, id);
      callbacks.set(id, { fn, references: 0 });
      emptyPolls = 0;
    }
    collectingCallbacks?.add(id);
    return id;
  }

  function dispatchCallbacks(result: NodePollResult): number {
    if (result.overflowed) throw bridgeError("Node callback queue overflowed", "ERR_ATOOLS_NODE_EVENT_OVERFLOW");
    for (const event of result.events) {
      const callback = callbacks.get(event.callbackId);
      // Cross-process callbacks are notifications. Their return value is not
      // available to Node; synchronous predicates must execute in local preload.
      if (callback) callback.fn(...event.args.map(codec.decode));
    }
    return result.events.length;
  }

  function drainSyncCallbacks() {
    if (!callbacks.size || draining) return;
    draining = true;
    try {
      if (dispatchCallbacks(transport.requestSync("poll", {}) as NodePollResult)) emptyPolls = 0;
    }
    finally { draining = false; }
  }

  function schedulePoll(active = false) {
    if (closed || polling || (!callbacks.size && !pending.size)) return;
    if (timer !== undefined) {
      if (!active) return;
      clearTimeout(timer);
    }
    const delay = pending.size || active || emptyPolls < 3 ? 50 : emptyPolls < 6 ? 250 : 1000;
    timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
  }

  async function poll() {
    if (closed || polling || (!callbacks.size && !pending.size)) return;
    polling = true;
    let activity = 0;
    try {
      if (callbacks.size) {
        const events = await transport.requestAsync("poll", {}) as NodePollResult;
        if (closed) return;
        activity += dispatchCallbacks(events);
      }
      const states = await pollPromiseStates([...pending.keys()]);
      if (closed || states === undefined) return;
      // A final progress event may be queued while pollPromise resolves. Drain
      // it before releasing per-call callback references and resolving the UI.
      if (callbacks.size && [...states.values()].some((state) => state.state !== "pending")) {
        activity += dispatchCallbacks(await transport.requestAsync("poll", {}) as NodePollResult);
      }
      if (closed) return;
      for (const [handleId, state] of states) {
        if (state.state === "pending") continue;
        const waiter = pending.get(handleId);
        if (!waiter) continue;
        activity += 1;
        if (state.state === "rejected") {
          forgetCallbacks(waiter.callbackIds);
          pending.delete(handleId);
          waiter.reject(bridgeError(state.error.message, state.error.code));
        } else {
          const result = codec.decode(state.value);
          const handle = result && handleDescriptors.get(result);
          if (typeof result === "function" && handle && waiter.callbackIds.length) {
            unsubscribeCallbacks.set(handle.handleId, [...(unsubscribeCallbacks.get(handle.handleId) ?? []), ...waiter.callbackIds]);
          } else forgetCallbacks(waiter.callbackIds);
          pending.delete(handleId);
          waiter.resolve(result);
        }
      }
      emptyPolls = activity ? 0 : emptyPolls + 1;
    } catch (error) {
      if (!closed) {
        if (!pending.size) console.error("[ATools Node module bridge] callback polling failed", error);
        close(error instanceof Error ? error : bridgeError(String(error)));
      }
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  function makePromise(handleId: number): Promise<unknown> {
    const existing = promises.get(handleId)?.deref();
    if (existing) return existing;
    const promise = new Promise((resolve, reject) => pending.set(handleId, { resolve, reject, callbackIds: [] }));
    promises.set(handleId, reference(promise, handleId));
    schedulePoll(true);
    return promise;
  }

  function invoke(handleId: number, args: unknown[], construct = false): any {
    assertOpen();
    const ids = new Set<string>();
    const previous = collectingCallbacks;
    collectingCallbacks = ids;
    let encoded: EncodedNodeValue[];
    try { encoded = codec.encodeMany(args); }
    catch (error) {
      forgetCallbacks([...ids].filter((id) => callbacks.get(id)?.references === 0), true);
      throw error;
    }
    finally { collectingCallbacks = previous; }
    for (const id of ids) callbacks.get(id)!.references += 1;
    try {
      const raw = transport.requestSync(construct ? "construct" : "call", { handleId, args: encoded }) as EncodedNodeValue;
      const cleanup = unsubscribeCallbacks.get(handleId);
      if (cleanup) { unsubscribeCallbacks.delete(handleId); forgetCallbacks(cleanup); }
      drainSyncCallbacks();
      const result = codec.decode(raw);
      if (raw.kind === "promise") {
        const waiter = pending.get(raw.handleId);
        if (waiter) waiter.callbackIds.push(...ids);
        else forgetCallbacks(ids);
      }
      else if (typeof result === "function" && ids.size) {
        const handle = handleDescriptors.get(result)!;
        unsubscribeCallbacks.set(handle.handleId, [...(unsubscribeCallbacks.get(handle.handleId) ?? []), ...ids]);
      }
      schedulePoll(true);
      return result;
    } catch (error) { forgetCallbacks(ids); throw error; }
  }

  function setProperty(handleId: number, property: string | symbol, value: unknown): boolean {
    assertOpen();
    if (typeof property !== "string" || ["__proto__", "prototype", "constructor"].includes(property)) {
      throw bridgeError(`Blocked remote property: ${String(property)}`, "ERR_ATOOLS_NODE_PROPERTY");
    }
    if (typeof value === "function") throw bridgeError("Function property assignments are unsupported", "ERR_ATOOLS_NODE_SET_CALLBACK");
    const ids = new Set<string>(), previous = collectingCallbacks;
    collectingCallbacks = ids;
    let encoded: EncodedNodeValue;
    try {
      encoded = codec.encode(value);
      if (ids.size) throw bridgeError("Callback property assignments are unsupported", "ERR_ATOOLS_NODE_SET_CALLBACK");
    } finally {
      collectingCallbacks = previous;
      forgetCallbacks([...ids].filter((id) => callbacks.get(id)?.references === 0), true);
    }
    const result = transport.requestSync("set", { handleId, property, value: encoded });
    if (typeof result !== "boolean") throw bridgeError("Invalid Node property assignment response");
    return result;
  }

  function makeHandle(descriptor: NodeHandleDescriptor): object {
    const existing = handles.get(descriptor.handleId);
    const existingProxy = existing?.reference.deref();
    if (existing && existingProxy) {
      // A re-encoded object's current bounded keys replace the old snapshot;
      // merging every historical name leaks memory on long-lived mutable objects.
      existing.descriptor.keys = descriptor.keys;
      return existingProxy;
    }
    const target = descriptor.callable ? function remoteNodeHandle() {}.bind(null) : Object.create(null);
    const proxy = new Proxy(target, {
      get(_target, property) {
        if (property === "then") return undefined; // Prevent accidental Promise assimilation.
        if (property === Symbol.toStringTag) return "NodeModuleHandle";
        if (typeof property !== "string") return undefined;
        assertOpen();
        if (["__proto__", "prototype", "constructor"].includes(property)) {
          throw bridgeError(`Blocked remote property: ${property}`, "ERR_ATOOLS_NODE_PROPERTY");
        }
        return codec.decode(transport.requestSync("get", { handleId: descriptor.handleId, property }) as EncodedNodeValue);
      },
      apply(_target, _receiver, args) { return invoke(descriptor.handleId, args); },
      construct(_target, args) { return invoke(descriptor.handleId, args, true); },
      ownKeys() { return [...new Set([...Reflect.ownKeys(target), ...descriptor.keys])]; },
      getOwnPropertyDescriptor(_target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property)
          ?? (typeof property === "string" && descriptor.keys.includes(property) ? { configurable: true, enumerable: true } : undefined);
      },
      set(_target, property, value) { return setProperty(descriptor.handleId, property, value); },
      defineProperty() { throw bridgeError("Remote property descriptor changes are unsupported", "ERR_ATOOLS_NODE_PROPERTY"); },
      deleteProperty() { throw bridgeError("Remote property deletion is unsupported", "ERR_ATOOLS_NODE_PROPERTY"); },
    });
    handles.set(descriptor.handleId, { reference: reference(proxy, descriptor.handleId), descriptor });
    handleDescriptors.set(proxy, descriptor);
    return proxy;
  }

  function registerAlias(wrapper: object, raw: object): void {
    const descriptor = handleDescriptors.get(raw);
    if (!descriptor) return;
    handleDescriptors.set(wrapper, descriptor);
    const existing = handles.get(descriptor.handleId);
    if (existing?.reference.deref() === raw) {
      // Keep the wrapper canonical for later decode of this same remote handle.
      // The wrapper retains the raw proxy, so its existing finalizer still owns
      // the remote handle lifetime without a second strong cache.
      existing.reference = reference(wrapper, descriptor.handleId);
    }
  }

  const fileHandleAdapters = createFileHandleAdapters(assertOpen, registerAlias);

  const codec = createCodec({ handle: makeHandle, promise: makePromise, callback: registerCallback, existingHandle: (value) => handleDescriptors.get(value) }, undefined, createPayloadBudget);

  function close(reason = bridgeError("Node module session is closed", "ERR_ATOOLS_NODE_SESSION_CLOSED")) {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const handleIds = [...new Set([...handles.keys(), ...promises.keys(), ...garbage])];
    const releasedCallbacks = [...callbacks.keys()];
    for (const waiter of pending.values()) waiter.reject(reason);
    pending.clear(); callbacks.clear(); modules.clear(); handles.clear(); promises.clear(); garbage.clear(); unsubscribeCallbacks.clear();
    (globalThis as any).window?.removeEventListener("pagehide", onPageHide);
    // Keep each release packet within the host's combined 4096-id limit while
    // making independent, strictly-positive progress through both collections.
    let handleOffset = 0;
    let callbackOffset = 0;
    while (handleOffset < handleIds.length || callbackOffset < releasedCallbacks.length) {
      const handleCount = Math.min(4096, handleIds.length - handleOffset);
      const callbackCount = Math.min(4096 - handleCount, releasedCallbacks.length - callbackOffset);
      if (handleCount + callbackCount === 0) break;
      void transport.requestAsync("release", {
        handleIds: handleIds.slice(handleOffset, handleOffset + handleCount),
        callbackIds: releasedCallbacks.slice(callbackOffset, callbackOffset + callbackCount),
      }).catch(() => {});
      handleOffset += handleCount;
      callbackOffset += callbackCount;
    }
  }

  function onPageHide() { close(); }
  (globalThis as any).window?.addEventListener("pagehide", onPageHide, { once: true });
  const requireModule = ((specifier: string) => {
    assertOpen();
    if (typeof specifier !== "string" || !specifier) throw new TypeError("A Node module specifier is required");
    if (specifier === "electron") {
      if (typeof localRequire !== "function") throw bridgeError("Electron requires the local host shim", "ERR_ATOOLS_NODE_LOCAL_ELECTRON");
      return localRequire("electron");
    }
    if (modules.has(specifier)) return modules.get(specifier);
    const raw = codec.decode(transport.requestSync("require", { specifier }) as EncodedNodeValue);
    const result = fileHandleAdapters.wrapModule(specifier, raw);
    modules.set(specifier, result);
    return result;
  }) as NodeModuleRequire;
  requireModule.close = () => close();
  Object.assign(requireModule, createNativeFilesystem(rawTransport, assertOpen));
  requireModule.readPngPath = (path: string) => {
    assertOpen();
    if (typeof path !== "string") throw bridgeError("Invalid local PNG path", "ERR_ATOOLS_IMAGE_PATH_INVALID");
    const raw = rawTransport.requestSync("readPngPath", { path }) as EncodedNodeValue;
    const bytes = codec.decode(raw);
    if (!(bytes instanceof Uint8Array)) {
      throw bridgeError("Invalid bounded PNG response", "ERR_ATOOLS_IMAGE_PATH_RESPONSE");
    }
    return bytes;
  };
  requireModule.nativeImageRequestSync = (operation, params) => {
    assertOpen();
    if (operation !== "openPath" && operation !== "openBuffer" && operation !== "encode") {
      throw bridgeError("Unsupported NativeImage operation", "ERR_ATOOLS_NATIVE_IMAGE_OPERATION");
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw bridgeError("Invalid NativeImage request", "ERR_ATOOLS_NATIVE_IMAGE_REQUEST");
    }
    return rawTransport.requestSync("nativeImageTransform", { ...params, operation });
  };
  requireModule.releaseCallbacks = (...functions) => forgetCallbacks(functions.map((fn) => callbackIds.get(fn)).filter((id): id is string => id !== undefined), true);
  Object.defineProperties(requireModule, {
    createLocalBuffer: { value: (value: string | Uint8Array, encoding?: string) => codec.createLocalBuffer(value, encoding), enumerable: false },
    isLocalBuffer: { value: (value: unknown) => codec.isLocalBuffer(value), enumerable: false },
  });
  return requireModule;
}
