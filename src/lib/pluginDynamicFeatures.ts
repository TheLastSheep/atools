type Invoke = (method: string, args: unknown[]) => unknown;

/** Injected verbatim. Every operation uses the existing authorized data session. */
export function createPluginDynamicFeatures(invoke: Invoke) {
  function invalid(message: string): never { throw new TypeError("ERR_ATOOLS_FEATURE_ARGUMENT: " + message); }
  function code(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
      || new TextEncoder().encode(value).length > 256) invalid("Feature code must be a nonempty string of at most 256 bytes");
  }
  function codes(value: unknown): asserts value is string[] {
    if (!Array.isArray(value) || value.length > 128) invalid("At most 128 feature codes are supported per operation");
    value.forEach(code);
  }
  function feature(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Feature must be an object");
    code((value as { code?: unknown }).code);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 16 * 1024) invalid("Feature exceeds 16 KiB");
  }
  function boolean(method: string, args: unknown[]): boolean {
    const value = invoke(method, args);
    if (typeof value !== "boolean") throw new Error("ERR_ATOOLS_FEATURE_RESPONSE: Expected a synchronous boolean");
    return value;
  }
  function setFeature(value: unknown): boolean {
    if (Array.isArray(value)) {
      if (value.length > 128) invalid("At most 128 features are supported per operation");
      value.forEach(feature);
    } else feature(value);
    return boolean("features.set", [value]);
  }
  return {
    getFeatures(filter?: unknown): Record<string, unknown>[] {
      if (filter !== undefined) codes(filter);
      const value = invoke("features.get", filter === undefined ? [] : [filter]);
      if (!Array.isArray(value) || value.length > 1000 || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("ERR_ATOOLS_FEATURE_RESPONSE: Expected a synchronous feature array");
      }
      return value;
    },
    setFeature,
    // Kept as a compatibility alias; batch commits remain atomic in the shared store.
    setFeatures: setFeature,
    removeFeature(value: unknown): boolean {
      if (Array.isArray(value)) codes(value); else code(value);
      return boolean("features.remove", [value]);
    },
  };
}
