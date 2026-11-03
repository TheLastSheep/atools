import { describe, expect, it, vi } from "vitest";
import { createPluginPanelMainFrameMount, type PluginPanelMainFrameMountPorts } from "../../src/lib/pluginPanelFrameMount";

function mountFixture(initialReservation: boolean) {
  let reserved = initialReservation;
  const registerFrame = vi.fn();
  const focusMainFrame = vi.fn(() => true);
  const reportReady = vi.fn();
  const ports: PluginPanelMainFrameMountPorts = {
    activePage: () => undefined,
    hasMainReservation: () => reserved,
    registerFrame,
    invalidateFrame: vi.fn(),
    unregisterMain: vi.fn(),
    focusMainFrame,
    reportReady,
  };
  const node = document.createElement("iframe");
  const destroy = createPluginPanelMainFrameMount(ports)(node).destroy;
  return { node, ports, registerFrame, focusMainFrame, reportReady, setReserved: (value: boolean) => { reserved = value; }, destroy };
}

describe("PluginPanel main frame reservation guard", () => {
  it("keeps unreserved preview frames usable without registering an IPC document", () => {
    const fixture = mountFixture(false);
    fixture.node.dispatchEvent(new Event("load"));

    expect(fixture.registerFrame).not.toHaveBeenCalled();
    expect(fixture.focusMainFrame).toHaveBeenCalledTimes(2);
    expect(fixture.reportReady).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it("registers a current main frame while its reservation exists", () => {
    const fixture = mountFixture(true);
    expect(fixture.registerFrame).toHaveBeenCalledWith({ kind: "main" }, fixture.node.contentWindow, true, false);
    fixture.node.dispatchEvent(new Event("load"));

    expect(fixture.registerFrame).toHaveBeenCalledTimes(2);
    expect(fixture.registerFrame).toHaveBeenLastCalledWith({ kind: "main" }, fixture.node.contentWindow, true, true);
    expect(fixture.reportReady).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it("does not bind a late load after the document reservation was cleared", () => {
    const fixture = mountFixture(true);
    fixture.setReserved(false);
    fixture.node.dispatchEvent(new Event("load"));

    expect(fixture.registerFrame).toHaveBeenCalledTimes(1);
    expect(fixture.reportReady).toHaveBeenCalledOnce();
    fixture.destroy();
  });
});
