import type { InstalledPlugin } from "./types";

export const PLUGIN_OPEN_REQUESTED_EVENT = "atools-plugin-open-requested";
export const PLUGIN_OPEN_CANCELLED_EVENT = "atools-plugin-open-cancelled";

export type PluginOpenFailure = "unavailable" | "activation-failed" | "superseded";

export type PluginOpenOutcome =
  | { status: "committed" }
  | { status: "failed"; reason: Exclude<PluginOpenFailure, "superseded"> }
  | { status: "superseded" };

export type PluginOpenRequest = {
  code: string;
  pluginId: string;
  requestId?: string;
  respond?: (outcome: PluginOpenOutcome) => void;
};

export type PluginOpenState = {
  requestId: string | null;
  pluginId: string | null;
  busy: boolean;
  message: string;
};

export function firstOpenablePluginFeature(plugin: InstalledPlugin | null | undefined): PluginOpenRequest | null {
  if (!plugin?.enabled) return null;
  const feature = plugin.manifest.features?.find((item) => typeof item.code === "string" && item.code.trim().length > 0);
  if (!feature) return null;
  return { code: feature.code, pluginId: plugin.id };
}

/** Resolve a caller-selected feature only from this enabled plugin's own manifest. */
export function exactOpenablePluginFeature(
  plugin: InstalledPlugin | null | undefined,
  featureCode: string,
): PluginOpenRequest | null {
  if (!plugin?.enabled || typeof featureCode !== "string" || !featureCode.trim()) return null;
  const feature = plugin.manifest.features?.find((item) => item.code === featureCode && item.code.trim().length > 0);
  return feature ? { code: feature.code, pluginId: plugin.id } : null;
}

/** Legacy fire-and-forget entry point retained for existing CustomEvent consumers. */
export function dispatchPluginOpenRequest(plugin: InstalledPlugin | null | undefined): boolean {
  const request = firstOpenablePluginFeature(plugin);
  if (!request || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent<PluginOpenRequest>(PLUGIN_OPEN_REQUESTED_EVENT, { detail: request }));
  return true;
}

let nextRequestId = 0;

export class PluginOpenController {
  private stateValue: PluginOpenState = { requestId: null, pluginId: null, busy: false, message: "" };
  private generation = 0;

  constructor(
    private readonly onState: (state: PluginOpenState) => void,
    private readonly onCommitted: (pluginId: string) => void,
  ) {}

  get state(): PluginOpenState { return this.stateValue; }

  open(plugin: InstalledPlugin | null | undefined, featureCode?: string): boolean {
    const request = featureCode === undefined
      ? firstOpenablePluginFeature(plugin)
      : exactOpenablePluginFeature(plugin, featureCode);
    if (!request || this.stateValue.busy || typeof window === "undefined") return false;

    const generation = ++this.generation;
    const requestId = `plugin-open-${++nextRequestId}`;
    let responded = false;
    this.setState({ requestId, pluginId: request.pluginId, busy: true, message: "正在打开插件…" });

    const respond = (outcome: PluginOpenOutcome) => {
      if (responded) return;
      responded = true;
      if (generation !== this.generation || this.stateValue.requestId !== requestId) return;
      if (outcome.status === "committed") {
        this.setState({ requestId: null, pluginId: request.pluginId, busy: false, message: "" });
        this.onCommitted(request.pluginId);
        return;
      }
      const message = outcome.status === "superseded"
        ? "打开请求已被新的操作取代，可以重试。"
        : outcome.reason === "unavailable"
          ? "当前无法打开插件，请重试。"
          : "插件未能打开，请检查插件状态后重试。";
      this.setState({ requestId: null, pluginId: request.pluginId, busy: false, message });
    };

    const event = new CustomEvent<PluginOpenRequest>(PLUGIN_OPEN_REQUESTED_EVENT, {
      cancelable: true,
      detail: { ...request, requestId, respond },
    });
    window.dispatchEvent(event);
    // A listener must claim the request synchronously. Old fire-and-forget
    // listeners remain compatible, but they cannot report an accepted open.
    if (!event.defaultPrevented) respond({ status: "failed", reason: "unavailable" });
    return true;
  }

  cancel(): void {
    if (this.stateValue.requestId && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PLUGIN_OPEN_CANCELLED_EVENT, { detail: { requestId: this.stateValue.requestId } }));
    }
    this.generation += 1;
    this.setState({ requestId: null, pluginId: null, busy: false, message: "" });
  }

  private setState(state: PluginOpenState): void {
    this.stateValue = state;
    this.onState(state);
  }
}
