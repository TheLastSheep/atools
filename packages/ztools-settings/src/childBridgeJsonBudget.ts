export function isJsonWithinByteBudget(value: unknown, maxBytes: number): boolean {
  try {
    const json = JSON.stringify(value)
    return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= maxBytes
  } catch {
    return false
  }
}

export function isPlainDataRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
        descriptor.enumerable && 'value' in descriptor
      )
  } catch {
    return false
  }
}
