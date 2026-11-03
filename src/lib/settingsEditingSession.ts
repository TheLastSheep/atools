import { normalizeSettings, type AToolsSettings } from "./settings";
import { readGeneralSettingsSnapshot } from "./generalSettingsStore";
import { beginSettingsReadRequest, openSettingsReadLease } from "./settingsReadSession";

export type OpenSettingsEditingSessionOptions = { signal?: AbortSignal };

/** Opens one WebView's temporary authoritative settings snapshot for an edit session. */
export async function openSettingsEditingSession(
  options: OpenSettingsEditingSessionOptions = {},
): Promise<{ settings: AToolsSettings; raw: string | null; close(): void }> {
  const { signal } = options;
  throwIfAborted(signal);
  const request = beginSettingsReadRequest();
  const snapshot = await readGeneralSettingsSnapshot();
  throwIfAborted(signal);
  const settings = normalizeSettings(snapshot.value as Partial<AToolsSettings>);
  throwIfAborted(signal);
  const lease = openSettingsReadLease(request, settings, snapshot);
  if (!lease) throw new Error("Settings editing session was superseded by a newer open request");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    lease.close();
  };
  const onAbort = () => close();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    close();
    throw abortError();
  }
  return { settings: lease.settings, raw: lease.raw, close };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Settings editing session open was aborted");
  error.name = "AbortError";
  return error;
}
