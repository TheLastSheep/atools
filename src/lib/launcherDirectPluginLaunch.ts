export const DIRECT_PLUGIN_LAUNCH_EVENT = "atools://direct-launch-plugin";
type DirectLaunch = {
    code: string;
    pluginId: string;
    shortcutDispatchId?: string;
};
type Options = {
    subscribe: (receive: (event: {
        payload: unknown;
    }) => void) => Promise<() => void>;
    activate: (request: DirectLaunch, isCancelled: () => boolean) => Promise<unknown>;
    onError: (error: unknown) => void;
};
function nonemptyIdentity(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
}
/** Native hotkeys use pluginId; legacy senders may use plugin_id. An owner must be unambiguous. */
export function directPluginLaunchRequest(payload: unknown): DirectLaunch | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const value = payload as Record<string, unknown>;
    if (!nonemptyIdentity(value.code))
        return null;
    const canonical = Object.hasOwn(value, "pluginId");
    const legacy = Object.hasOwn(value, "plugin_id");
    if ((canonical && !nonemptyIdentity(value.pluginId)) || (legacy && !nonemptyIdentity(value.plugin_id)))
        return null;
    if (canonical && legacy && value.pluginId !== value.plugin_id)
        return null;
    const pluginId = canonical ? value.pluginId : value.plugin_id;
    if (!nonemptyIdentity(pluginId)) return null;
    const id = value.shortcutDispatchId;
    if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))) return null;
    return { code: value.code, pluginId, ...(id === undefined ? {} : { shortcutDispatchId: id }) };
}
/** Cleanup owns both installed and still-resolving listeners, including callbacks already queued by the host. */
export function subscribeLauncherDirectPluginLaunch(options: Options): () => void {
    let disposed = false;
    let stop: (() => void) | undefined;
    const receive = (event: {
        payload: unknown;
    }) => {
        if (disposed)
            return;
        const request = directPluginLaunchRequest(event?.payload);
        if (!request) {
            options.onError(new Error("Invalid direct plugin launch identity"));
            return;
        }
        void Promise.resolve().then(() => {
            if (!disposed)
                return options.activate(request, () => disposed);
        }).catch(error => {
            if (!disposed)
                options.onError(error);
        });
    };
    try {
        void options.subscribe(receive).then(unsubscribe => {
            if (disposed)
                unsubscribe();
            else
                stop = unsubscribe;
        }).catch(error => {
            if (!disposed)
                options.onError(error);
        });
    }
    catch (error) {
        if (!disposed)
            options.onError(error);
    }
    return () => {
        if (disposed)
            return;
        disposed = true;
        stop?.();
        stop = undefined;
    };
}

/** Completion follows the entire activation Promise, including post-commit work. */
export async function runTicketedDirectLaunch(
    request: DirectLaunch,
    isCancelled: () => boolean,
    activate: (outcome: (status: "committed" | "failed" | "superseded") => void, cancelled: () => boolean) => Promise<unknown>,
    complete: (id: string, outcome: "committed" | "failed" | "superseded") => Promise<unknown>,
): Promise<unknown> {
    const id = request.shortcutDispatchId;
    if (!id) throw new Error("Missing shortcut dispatch identity");
    let outcome: "committed" | "failed" | "superseded" = "failed";
    try { return await activate(status => { outcome = status; }, isCancelled); }
    finally { await complete(id, outcome); }
}
