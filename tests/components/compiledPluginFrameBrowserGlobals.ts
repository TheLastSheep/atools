/** Browser globals from a real JSDOM iframe, matching a plugin srcdoc realm. */
export interface CompiledPluginFrameBrowserGlobals {
  readonly location: Location;
  readonly history: History;
  readonly Event: typeof Event;
  readonly CustomEvent: typeof CustomEvent;
  dispose(): void;
}

export function createCompiledPluginFrameBrowserGlobals(): CompiledPluginFrameBrowserGlobals {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    frame.remove();
    throw new Error("JSDOM iframe did not create a browser Window");
  }
  const browser = frameWindow as Window & typeof globalThis;
  return {
    location: browser.location,
    history: browser.history,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    dispose: () => frame.remove(),
  };
}
