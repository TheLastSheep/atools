import { createPluginNodePosixPath } from "./pluginNodePosixPath";
import { createPluginNodeFs, type PluginNodeFsModule } from "./pluginNodeFs";

type PluginNativeTextReadResult = { handled: true; value: string } | { handled: false };
type PluginNativeTextWriteResult = { handled: true } | { handled: false };
type PluginModuleHostRequire = ((specifier: string) => unknown) & {
  readTextPath?: (path: string) => PluginNativeTextReadResult;
  writeTextPath?: (path: string, text: string) => PluginNativeTextWriteResult;
};

export type PluginModuleAdapterRequire = ((specifier: string) => unknown) & {
  close: () => void;
  canHandle: (specifier: string) => boolean;
};

/**
 * Dispatch CommonJS modules to the existing host bridge, with a local POSIX
 * path implementation and bounded UTF-8 fs reads/writes for absolute POSIX
 * plugin roots. Path `_makeLong` stays in-process; unsupported path members
 * and fs reflection/operations lazily use the host. The host require is
 * borrowed and remains owned by its caller.
 */
export function createPluginModuleAdapter(
  cwd: string,
  hostRequire: PluginModuleHostRequire | undefined,
  createPath: typeof createPluginNodePosixPath,
  createFs: typeof createPluginNodeFs = createPluginNodeFs,
): PluginModuleAdapterRequire {
  const pathSpecifiers = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
  const fsSpecifiers = new Set(["fs", "node:fs"]);
  const posixAbsolute = cwd.startsWith("/")
    && !/^[a-zA-Z]:[\\/]/.test(cwd)
    && !cwd.startsWith("\\\\");
  const localPath = posixAbsolute ? createPath(cwd) : undefined;
  const readTextPath = posixAbsolute && typeof hostRequire?.readTextPath === "function"
    ? hostRequire.readTextPath
    : undefined;
  const writeTextPath = posixAbsolute && typeof hostRequire?.writeTextPath === "function"
    ? hostRequire.writeTextPath
    : undefined;
  const hostPathMembers = new Set<PropertyKey>(["win32", "matchesGlob"]);
  const localFunctionCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  let closed = false;
  let pathFacade: object | undefined;
  let fsFacade: PluginNodeFsModule | undefined;
  let closeFsFacade: (() => void) | undefined;

  function closedError(): Error & { code: string } {
    const error = new Error("Plugin module adapter is closed") as Error & { code: string };
    error.code = "ERR_ATOOLS_PLUGIN_MODULE_ADAPTER_CLOSED";
    return error;
  }

  function assertOpen(): void {
    if (closed) throw closedError();
  }

  function moduleNotFound(specifier: string): Error & { code: string } {
    const error = new Error(`Cannot find module '${specifier}'`) as Error & { code: string };
    error.code = "MODULE_NOT_FOUND";
    return error;
  }

  function dispatchToHost(specifier: string): unknown {
    assertOpen();
    if (typeof hostRequire !== "function") throw moduleNotFound(specifier);
    return hostRequire(specifier);
  }

  if (readTextPath || writeTextPath) {
    const nativeRead = readTextPath
      ? (path: string): PluginNativeTextReadResult => readTextPath.call(hostRequire, path)
      : undefined;
    const nativeWrite = writeTextPath
      ? (path: string, text: string): PluginNativeTextWriteResult => writeTextPath.call(hostRequire, path, text)
      : undefined;
    const nativeFs = createFs(nativeRead, () => dispatchToHost("node:fs") as object, nativeWrite);
    fsFacade = nativeFs.module;
    closeFsFacade = nativeFs.close;
  }

  if (localPath) {
    const nativePath = localPath;
    const facadeTarget = Object.create(null) as object;

    function getLocalMember(property: PropertyKey): unknown {
      if (!Reflect.getOwnPropertyDescriptor(nativePath, property)) return undefined;
      const member = Reflect.get(nativePath, property, nativePath) as unknown;
      if (typeof member !== "function") return member;

      const cached = localFunctionCache.get(property);
      if (cached) return cached;

      const wrapped = (...args: unknown[]) => {
        assertOpen();
        return Reflect.apply(member, localPath, args);
      };
      localFunctionCache.set(property, wrapped);
      return wrapped;
    }

    pathFacade = new Proxy(facadeTarget, {
      get(_target, property) {
        assertOpen();
        if (property === "posix") return pathFacade;
        if (property === "_makeLong") return getLocalMember("toNamespacedPath");

        if (Reflect.getOwnPropertyDescriptor(localPath, property)) {
          return getLocalMember(property);
        }

        if (hostPathMembers.has(property)) {
          const hostPath = dispatchToHost("node:path") as object;
          return Reflect.get(hostPath, property, hostPath);
        }
        return undefined;
      },
      has(_target, property) {
        assertOpen();
        return property === "posix"
          || property === "_makeLong"
          || Boolean(Reflect.getOwnPropertyDescriptor(localPath, property));
      },
      ownKeys() {
        assertOpen();
        const keys = new Set(Reflect.ownKeys(localPath));
        keys.add("posix");
        keys.add("_makeLong");
        return [...keys];
      },
      getOwnPropertyDescriptor(_target, property) {
        assertOpen();
        if (property === "posix") {
          return { configurable: true, enumerable: true, writable: true, value: pathFacade };
        }

        const localProperty = property === "_makeLong" ? "toNamespacedPath" : property;
        const descriptor = Reflect.getOwnPropertyDescriptor(localPath, localProperty);
        if (!descriptor) return undefined;
        const value = getLocalMember(localProperty);
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: "writable" in descriptor ? descriptor.writable : false,
          value,
        };
      },
    });
  }

  const adaptedRequire = ((specifier: string): unknown => {
    assertOpen();
    if (typeof specifier !== "string") throw new TypeError("CommonJS module name must be a string");
    if (pathFacade && pathSpecifiers.has(specifier)) return pathFacade;
    if (fsFacade && fsSpecifiers.has(specifier)) return fsFacade;
    return dispatchToHost(specifier);
  }) as PluginModuleAdapterRequire;

  adaptedRequire.canHandle = (specifier: string): boolean =>
    Boolean(pathFacade && pathSpecifiers.has(specifier));
  adaptedRequire.close = (): void => {
    if (closed) return;
    closed = true;
    closeFsFacade?.();
    localFunctionCache.clear();
  };

  return adaptedRequire;
}

/** Build a self-contained expression for the isolated plugin iframe. */
export function pluginModuleAdapterExpression(cwd: string, hostRequireExpression: string): string {
  const encodedCwd = JSON.stringify(cwd).replace(/</g, "\\u003c");
  return `(${createPluginModuleAdapter.toString()})(${encodedCwd}, (${hostRequireExpression}), (${createPluginNodePosixPath.toString()}), (${createPluginNodeFs.toString()}))`;
}
