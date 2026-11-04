export type EncodedNodeValue =
  | { kind: "value"; value: null | boolean | number | string }
  | { kind: "undefined" }
  | { kind: "number"; value: "NaN" | "Infinity" | "-Infinity" }
  | { kind: "bigint"; value: string }
  | { kind: "buffer"; data: string }
  | { kind: "date"; value: string }
  | { kind: "typedArray"; name: string; data: string }
  | { kind: "array"; items: EncodedNodeValue[] }
  | { kind: "object"; properties: Record<string, EncodedNodeValue> }
  | { kind: "fsStats"; properties: Record<string, EncodedNodeValue> }
  | { kind: "fsDirent"; properties: Record<string, EncodedNodeValue>; type: number }
  | { kind: "handle"; handleId: number; callable: boolean; keys: string[]; callableKeys?: string[] }
  | { kind: "promise"; handleId: number }
  | { kind: "callback"; id: string }
  | { kind: "error"; name: string; message: string; code?: string; stack?: string };

export type NodeHandleDescriptor = Extract<EncodedNodeValue, { kind: "handle" }>;
export type NodeModuleSessionConfig = { endpoint: string };
export type NodeModuleTransport = {
  /** set params: { handleId, property, value: EncodedNodeValue }; result: boolean. */
  requestSync: (method: string, params: Record<string, unknown>) => unknown;
  requestAsync: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};
export type NodeCallbackEvent = { callbackId: string; args: EncodedNodeValue[] };
export type NodePollResult = { events: NodeCallbackEvent[]; overflowed: boolean };
export type NodePromiseState =
  | { state: "pending" }
  | { state: "fulfilled"; value: EncodedNodeValue }
  | { state: "rejected"; error: { message: string; code?: string } };
export type NodePromiseBatchState = { handleId: number; state: NodePromiseState };
export type NodePromiseBatchResult = { states: NodePromiseBatchState[]; fallback: number[] };

export type NodeTextReadResult = { handled: true; value: string } | { handled: false };
export type NodeTextWriteResult = { handled: true } | { handled: false };

export type NodeModuleRequire = {
  (specifier: string): any;
  close: () => void;
  /** Read one bounded PNG through the active legacy-node session. */
  readPngPath: (path: string) => Uint8Array;
  /** Bounded UTF-8 read using the same authorized session; false delegates to Node. */
  readTextPath?: (path: string) => NodeTextReadResult;
  /** Ordinary bounded UTF-8 overwrite through the same authorized session. */
  writeTextPath?: (path: string, text: string) => NodeTextWriteResult;
  /** NativeImage transform channel with its own strict operation schema. */
  nativeImageRequestSync: (operation: "openPath" | "openBuffer" | "encode", params: Record<string, unknown>) => unknown;
  /** End callback-only subscriptions; Promise-scoped callbacks release on settlement. */
  releaseCallbacks: (...callbacks: Function[]) => void;
  /** Local-only codec-owned Buffer factory; this never sends an RPC. */
  createLocalBuffer?: (value: string | Uint8Array, encoding?: string) => Uint8Array;
  /** True only for byte objects created/decoded by this session codec. */
  isLocalBuffer?: (value: unknown) => boolean;
};
