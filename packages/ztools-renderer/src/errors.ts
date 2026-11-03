const ERROR_PREFIX = "ERR_ATOOLS_ZTOOLS_";
export const HOST_ERROR_CODES = {
  UNSUPPORTED: ERROR_PREFIX + "UNSUPPORTED",
  DISPOSED: ERROR_PREFIX + "DISPOSED",
  INVALID_RESPONSE: ERROR_PREFIX + "INVALID_RESPONSE",
  INVALID_ARGUMENT: ERROR_PREFIX + "INVALID_ARGUMENT",
} as const;

export const HOST_ERROR_MESSAGES = {
  DISPOSED: "ZTools adapter disposed.",
  INVALID_CALLBACK: "Expected function.",
  UNKNOWN_CALLBACK: "Unknown callback.",
  CALLBACK_LIMIT: (name: string) => `${name}: callback limit.`,
} as const;

export type ZToolsRendererHostErrorCode = typeof HOST_ERROR_CODES[keyof typeof HOST_ERROR_CODES];

export class ZToolsRendererHostError extends Error {
  readonly code: ZToolsRendererHostErrorCode;

  constructor(code: ZToolsRendererHostErrorCode, message: string) {
    super(message);
    this.name = "ZToolsRendererHostError";
    this.code = code;
  }
}

export function assertRendererCallback(callback: unknown): void {
  if (typeof callback !== "function") {
    throw invalidRendererArgument(HOST_ERROR_MESSAGES.INVALID_CALLBACK);
  }
}

export function rendererHostError(
  code: ZToolsRendererHostErrorCode,
  message: string,
): ZToolsRendererHostError {
  return new ZToolsRendererHostError(code, message);
}

export function invalidRendererArgument(message: string): ZToolsRendererHostError {
  return rendererHostError(HOST_ERROR_CODES.INVALID_ARGUMENT, message);
}

export function invalidRendererResponse(message: string): ZToolsRendererHostError {
  return rendererHostError(HOST_ERROR_CODES.INVALID_RESPONSE, message);
}

export function adapterDisposedError(): ZToolsRendererHostError {
  return rendererHostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
}

export function unsupported(method: string): ZToolsRendererHostError {
  return rendererHostError(
    HOST_ERROR_CODES.UNSUPPORTED,
    `Unsupported ZTools method: ${method}`,
  );
}
