import { createPluginPanelBrowserWindowRuntime, type PluginPanelBrowserWindowRuntimePorts } from "./pluginPanelBrowserWindowRuntime";
import type { createPluginPanelBrowserWindowState } from "./pluginPanelBrowserWindowState.svelte.js";

type Options = Pick<PluginPanelBrowserWindowRuntimePorts,
  "action" | "invoke" | "previewPluginPath" | "previewPayload" | "hasPluginPage" | "resources" | "activePluginRuntime" | "injectBridge" | "mountNativeFrame" | "tick">
  & { state: ReturnType<typeof createPluginPanelBrowserWindowState>; mainFrame: PluginPanelBrowserWindowRuntimePorts["mainFrame"] };

/** Adapts panel owned BrowserWindow state and frame ports to the runtime host. */
export function createPluginPanelBrowserWindowRuntimeBindings(options: Options) {
  const state = options.state, windowState = state.windowState;
  return createPluginPanelBrowserWindowRuntime({
    get windows() { return state.windows; }, set windows(value) { state.windows = value; },
    get lastMessage() { return state.lastMessage; }, set lastMessage(value) { state.lastMessage = value; },
    navigation: state.navigation, rpc: state.rpc, frames: state.frames, geometry: state.geometry,
    hostedIpc: state.hostedIpc, sources: state.sources, insertedCss: state.insertedCss,
    get cssSequence() { return state.cssSequence; }, set cssSequence(value) { state.cssSequence = value; },
    get findSequence() { return state.findSequence; }, set findSequence(value) { state.findSequence = value; },
    creators: state.creators, mainFrame: options.mainFrame, post: state.post,
    get hostGeneration() { return state.hostGeneration; }, set hostGeneration(value) { state.hostGeneration = value; },
    get creatingCount() { return state.creatingCount; }, set creatingCount(value) { state.creatingCount = value; },
    get windowSequence() { return state.sequence; }, set windowSequence(value) { state.sequence = value; },
    nextZOrder: windowState.nextPluginBrowserWindowZOrder, clearInsertedCss: state.clearInsertedCss,
    readyFrame: async (id, label) => {
      const frame = state.frames.get(id);
      if (!frame?.contentWindow) throw new Error(`${label} failed: browser window ${id} frame is not ready`);
      await state.rpc.waitReady(id);
      return frame;
    },
    updateUserAgent: windowState.updatePluginBrowserWindowUserAgent,
    updateFrameRate: windowState.updatePluginBrowserWindowFrameRate,
    updateBackgroundThrottling: windowState.updatePluginBrowserWindowBackgroundThrottling,
    action: options.action, invoke: options.invoke, previewPluginPath: options.previewPluginPath, previewPayload: options.previewPayload,
    hasPluginPage: options.hasPluginPage, resources: options.resources, activePluginRuntime: options.activePluginRuntime, injectBridge: options.injectBridge,
    mountNativeFrame: options.mountNativeFrame, tick: options.tick,
  });
}
