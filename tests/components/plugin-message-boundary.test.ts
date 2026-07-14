import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { PluginFrameSourceRegistry, type PluginFrameIdentity } from "../../src/lib/pluginInvokePolicy";
import PluginMessageBoundaryHarness from "./PluginMessageBoundaryHarness.svelte";

afterEach(cleanup);

function dispatchMessage(source: object, data: unknown) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

describe("plugin message source boundary", () => {
  it("accepts only the current registered frame and detaches its window listener on unmount", () => {
    const sources = new PluginFrameSourceRegistry();
    const accepted: Array<{ identity: PluginFrameIdentity; data: unknown }> = [];
    const currentSource = { postMessage() {} };
    const replacementSource = { postMessage() {} };
    const foreignSource = { postMessage() {} };
    sources.setMain(currentSource);

    const view = render(PluginMessageBoundaryHarness, {
      sources,
      onaccepted: (identity, data) => accepted.push({ identity, data }),
    });

    dispatchMessage(foreignSource, "foreign");
    dispatchMessage(currentSource, "current");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.identity.kind).toBe("main");
    expect(accepted[0]?.data).toBe("current");

    sources.setMain(replacementSource);
    dispatchMessage(currentSource, "stale");
    dispatchMessage(replacementSource, "replacement");
    expect(accepted.map((entry) => entry.data)).toEqual(["current", "replacement"]);

    view.unmount();
    dispatchMessage(replacementSource, "after-unmount");
    expect(accepted).toHaveLength(2);
  });
});
