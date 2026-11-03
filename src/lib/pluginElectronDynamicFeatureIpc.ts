export type PluginElectronDynamicFeatureApi = {
  getFeatures: (codes?: unknown) => unknown;
  setFeature: (feature: unknown) => unknown;
  removeFeature: (code: unknown) => unknown;
};

/** Maps only the documented synchronous Electron aliases onto the active uTools owner bridge. */
export function createPluginElectronDynamicFeatureIpc(api?: PluginElectronDynamicFeatureApi | null) {
  const maxRequestBytes = 512 * 1024;
  const maxFeatureBytes = 16 * 1024;
  function failure(code: string, message: string) {
    const error = new Error(code + ": " + message) as Error & { code: string };
    error.code = code;
    return error;
  }
  function code(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
      || new TextEncoder().encode(value).byteLength > 256) {
      throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "Feature code must be a non-empty string of at most 256 bytes");
    }
  }
  function requestSize(value: unknown, budget: number, label: string) {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", label + " is not serializable"); }
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > budget) {
      throw failure("ERR_ATOOLS_FEATURE_LIMIT", label + " exceeds its byte budget");
    }
  }
  function codes(value: unknown) {
    if (!Array.isArray(value) || value.length > 128) {
      throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "At most 128 feature codes are supported");
    }
    value.forEach(code);
    requestSize(value, maxRequestBytes, "Feature code request");
  }
  function assertSynchronous(value: unknown) {
    if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function") {
      throw failure("ERR_ATOOLS_FEATURE_RESPONSE", "A synchronous feature operation returned a Promise");
    }
    return value;
  }
  function boundedResponse(value: unknown) {
    requestSize(value, maxRequestBytes, "Feature response");
    return value;
  }
  function requiredApi(method: keyof PluginElectronDynamicFeatureApi) {
    const handler = api?.[method];
    if (typeof handler !== "function") throw failure("ERR_ATOOLS_FEATURE_UNAVAILABLE", "The owner-scoped feature store is unavailable");
    return handler;
  }
  function setFeature(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "set-feature expects one feature object");
    }
    code((value as { code?: unknown }).code);
    requestSize(value, maxFeatureBytes, "Feature");
    try {
      const result = assertSynchronous(requiredApi("setFeature").call(api, value));
      if (typeof result !== "boolean") throw failure("ERR_ATOOLS_FEATURE_RESPONSE", "Expected a synchronous feature result");
      return boundedResponse(result ? { success: true } : { success: false, error: "Dynamic feature was not stored" });
    } catch (reason) {
      let message = "Dynamic feature operation failed";
      try {
        const detail = reason && typeof reason === "object" ? (reason as { message?: unknown }).message : undefined;
        if (typeof detail === "string" && detail.length) message = detail.slice(0, 512);
      } catch { /* A hostile error accessor must not escape the legacy result contract. */ }
      return boundedResponse({ success: false, error: message });
    }
  }
  return {
    sendSync(channel: unknown, ...args: unknown[]) {
      if (channel === "get-features") {
        if (args.length > 1) throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "get-features accepts zero or one code list");
        if (args.length === 1 && args[0] !== undefined) codes(args[0]);
        const result = assertSynchronous(requiredApi("getFeatures").call(api, args[0]));
        if (!Array.isArray(result) || result.length > 1000 || result.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
          throw failure("ERR_ATOOLS_FEATURE_RESPONSE", "Expected a synchronous feature array");
        }
        return boundedResponse(result);
      }
      if (channel === "set-feature") {
        if (args.length !== 1) throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "set-feature expects exactly one feature");
        return setFeature(args[0]);
      }
      if (channel === "remove-feature") {
        if (args.length !== 1) throw failure("ERR_ATOOLS_FEATURE_ARGUMENT", "remove-feature expects exactly one code");
        code(args[0]);
        const result = assertSynchronous(requiredApi("removeFeature").call(api, args[0]));
        if (typeof result !== "boolean") throw failure("ERR_ATOOLS_FEATURE_RESPONSE", "Expected a synchronous removal result");
        return boundedResponse(result);
      }
      throw failure("ERR_ATOOLS_ELECTRON_UNSUPPORTED", "Unsupported ipcRenderer.sendSync channel");
    },
  };
}
