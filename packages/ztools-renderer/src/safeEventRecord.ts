/** Copies only own enumerable data fields from an event payload. */
const INVALID_RECORD = Symbol();

function assertPlainRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
}

export function safeEventRecord(
  value: unknown,
  includeReservedKeys = false,
): Record<string, unknown> {
  try {
    assertPlainRecord(value);
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        (!includeReservedKeys && ["__proto__", "prototype", "constructor"].includes(key))
      ) throw INVALID_RECORD;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw INVALID_RECORD;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    throw new Error();
  }
}

export function exactEventRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = safeEventRecord(value);
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error();
  return record;
}

export function selectedEventRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assertPlainRecord(value);
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error();
    output[key] = descriptor.value;
  }
  return output;
}

export function denseEventArrayLength(value: unknown, limit: number): number {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  const length = value.length;
  if (length > limit || Reflect.ownKeys(value).length !== length + 1) throw new Error();
  return length;
}

export function denseEventArrayItem(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}
