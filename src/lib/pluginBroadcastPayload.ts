/**
 * Conservatively accounts one structured-clone broadcast payload.
 * Keep this function self-contained: the plugin renderer serializes it into
 * an isolated bridge, where module imports and module-scope helpers do not exist.
 */
export function measurePluginBroadcastPayload(value: unknown): number {
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_NODES = 8192;
  const MAX_DEPTH = 64;
  const QUOTA_CODE = "ERR_ATOOLS_BROADCAST_BUDGET";
  const CLONE_CODE = "ERR_ATOOLS_BROADCAST_DATA_CLONE";
  const ownedErrors = new WeakSet<object>();
  const visited = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  const makeError = (name: string, code: string, detail: string): Error => {
    const message = `${code}: ${detail}`;
    let error: Error;
    try {
      error = new DOMException(message, name);
    } catch {
      error = new Error(message);
      error.name = name;
    }
    ownedErrors.add(error);
    return error;
  };
  const quota = (): never => { throw makeError("QuotaExceededError", QUOTA_CODE, "payload exceeds the bounded clone budget"); };
  const dataClone = (): never => { throw makeError("DataCloneError", CLONE_CODE, "payload contains an unsupported or unsafe value"); };
  const charge = (amount: number): void => {
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_BYTES - bytes) quota();
    bytes += amount;
  };
  const chargeString = (text: string): void => {
    charge(8);
    const remaining = MAX_BYTES - bytes;
    // UTF-8 bytes are never fewer than UTF-16 code units, so this rejects a
    // huge string without walking or copying it.
    if (text.length > remaining) quota();
    let count = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code <= 0x7f) count += 1;
      else if (code <= 0x7ff) count += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          count += 4;
          index += 1;
        } else count += 3;
      } else count += 3;
      if (count > remaining) quota();
    }
    charge(count);
  };
  const ownGetterValue = (prototype: object, property: string, target: object): { found: boolean; value?: unknown } => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || typeof descriptor.get !== "function") return { found: false };
    try {
      return { found: true, value: Reflect.apply(descriptor.get, target, []) };
    } catch {
      return { found: false };
    }
  };
  const hasBrandMethod = (method: Function | undefined, target: object): boolean => {
    if (typeof method !== "function") return false;
    try {
      Reflect.apply(method, target, []);
      return true;
    } catch {
      return false;
    }
  };

  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) quota();
    nodes += 1;
    if (nodes > MAX_NODES) quota();
    charge(8);

    if (current === null || current === undefined || typeof current === "boolean" || typeof current === "number") return;
    if (typeof current === "string") {
      // The primitive's fixed slot was already charged above.
      bytes -= 8;
      chargeString(current);
      return;
    }
    if (typeof current === "bigint") {
      const maxBits = MAX_BYTES * 8;
      let bits = 1;
      while (bits < maxBits && BigInt.asIntN(bits, current) !== current) bits = Math.min(maxBits, bits * 2);
      if (BigInt.asIntN(bits, current) !== current) quota();
      charge(Math.ceil(bits / 8));
      return;
    }
    if (typeof current === "symbol" || typeof current === "function") dataClone();

    const object = current as object;
    if (visited.has(object)) return;
    visited.add(object);

    if (Array.isArray(object)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
        return dataClone();
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_NODES - nodes) quota();
      charge(8);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        chargeString(key);
        if (!descriptor || !descriptor.enumerable) visit(undefined, depth + 1);
        else if (!("value" in descriptor)) dataClone();
        else visit(descriptor.value, depth + 1);
      }
      const names = Object.getOwnPropertyNames(object);
      if (names.length > MAX_NODES) quota();
      for (const key of names) {
        if (key === "length") continue;
        const numericIndex = Number(key);
        if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < length && String(numericIndex) === key) continue;
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !descriptor.enumerable) continue;
        if (!("value" in descriptor)) dataClone();
        chargeString(key);
        visit(descriptor.value, depth + 1);
      }
      return;
    }

    if (typeof SharedArrayBuffer === "function") {
      const shared = ownGetterValue(SharedArrayBuffer.prototype, "byteLength", object);
      if (shared.found) dataClone();
    }

    const dateValue = hasBrandMethod(Date.prototype.getTime, object);
    if (dateValue) {
      charge(8);
      return;
    }

    const regexpSource = ownGetterValue(RegExp.prototype, "source", object);
    if (regexpSource.found) {
      chargeString(regexpSource.value as string);
      for (const flag of ["global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky"] as const) {
        const flagValue = ownGetterValue(RegExp.prototype, flag, object);
        if (flagValue.found) charge(1);
      }
      return;
    }

    if (typeof Map === "function") {
      const size = ownGetterValue(Map.prototype, "size", object);
      if (size.found) {
        const count = size.value as number;
        if (count > Math.floor((MAX_NODES - nodes) / 2)) quota();
        charge(8);
        Reflect.apply(Map.prototype.forEach, object, [(entry: unknown, key: unknown) => {
          charge(4);
          visit(key, depth + 1);
          visit(entry, depth + 1);
        }]);
        return;
      }
    }

    if (typeof Set === "function") {
      const size = ownGetterValue(Set.prototype, "size", object);
      if (size.found) {
        const count = size.value as number;
        if (count > MAX_NODES - nodes) quota();
        charge(8);
        Reflect.apply(Set.prototype.forEach, object, [(entry: unknown) => {
          charge(4);
          visit(entry, depth + 1);
        }]);
        return;
      }
    }

    const bufferLength = ownGetterValue(ArrayBuffer.prototype, "byteLength", object);
    if (bufferLength.found) {
      charge(bufferLength.value as number);
      if ((bufferLength.value as number) === 0) {
        try { new Uint8Array(object as ArrayBuffer, 0, 0); } catch { dataClone(); }
      }
      return;
    }

    if (ArrayBuffer.isView(object)) {
      const dataViewLength = ownGetterValue(DataView.prototype, "byteLength", object);
      if (dataViewLength.found) {
        const buffer = ownGetterValue(DataView.prototype, "buffer", object);
        if (!buffer.found) dataClone();
        visit(buffer.value, depth + 1);
        return;
      }
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
      const typedLength = ownGetterValue(typedArrayPrototype, "byteLength", object);
      const typedBuffer = ownGetterValue(typedArrayPrototype, "buffer", object);
      if (!typedLength.found || !typedBuffer.found) dataClone();
      visit(typedBuffer.value, depth + 1);
      return;
    }

    if (typeof Blob === "function") {
      const blobSize = ownGetterValue(Blob.prototype, "size", object);
      if (blobSize.found) {
        charge(blobSize.value as number);
        const blobType = ownGetterValue(Blob.prototype, "type", object);
        if (!blobType.found) dataClone();
        chargeString(blobType.value as string);
        if (typeof File === "function") {
          const fileName = ownGetterValue(File.prototype, "name", object);
          const fileModified = ownGetterValue(File.prototype, "lastModified", object);
          if (fileName.found && fileModified.found) {
            chargeString(fileName.value as string);
            charge(8);
          }
        }
        return;
      }
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== null && prototype !== Object.prototype) {
      const parentPrototype = Object.getPrototypeOf(prototype);
      const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
      const constructor = constructorDescriptor && "value" in constructorDescriptor ? constructorDescriptor.value : undefined;
      const nameDescriptor = typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name") : undefined;
      // Foreign-realm Object.prototype is recognized structurally without
      // consulting Symbol.toStringTag or executing a user-defined getter.
      if (parentPrototype !== null || nameDescriptor?.value !== "Object") dataClone();
    }

    const names = Object.getOwnPropertyNames(object);
    if (names.length > MAX_NODES - nodes) quota();
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !descriptor.enumerable) continue;
      if (!("value" in descriptor)) dataClone();
      chargeString(key);
      visit(descriptor.value, depth + 1);
    }
  };

  try {
    visit(value, 0);
    return bytes;
  } catch (error) {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      if (ownedErrors.has(error as object)) throw error;
    }
    return dataClone();
  }
}
