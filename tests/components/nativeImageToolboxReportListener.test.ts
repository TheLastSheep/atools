import { describe, expect, it } from "vitest";
import { listenForImageToolboxReport, parseNativeImageToolboxGeometry } from "./nativeImageToolboxReportListener";

type Listener = (event: Event) => void;
function target() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener === "function") listeners.add(listener as Listener);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener === "function") listeners.delete(listener as Listener);
    },
    emit(event: Partial<MessageEvent>) {
      for (const listener of [...listeners]) listener(event as MessageEvent as Event);
    },
  };
}

const reportMessage = { kind: "atools-image-toolbox-smoke", summary: { passed: true } };

describe("Image-Toolbox report listener lifecycle", () => {
  it("keeps only finite bounded geometry numbers and preserves missing measurements as null", () => {
    const valid = parseNativeImageToolboxGeometry({
      canvas: { width: 112, height: 72, zoom: 1 },
      container: { left: 0, top: 0, right: 112, bottom: 72, width: 112, height: 72 },
      child: { innerWidth: 112, innerHeight: 72, devicePixelRatio: 2 },
    });
    expect(valid.valid).toBe(true);
    const parsed = parseNativeImageToolboxGeometry({
      canvas: { width: 112, height: 72, zoom: 1 },
      container: { left: 0, top: 0, right: 112, bottom: 72, width: 112, height: 72 },
      child: { innerWidth: 112, innerHeight: 72, devicePixelRatio: 2 },
      rawPath: "/private/never-forward-this",
    });
    expect(parsed.valid).toBe(false);
    expect(parsed.geometry).toEqual({
      canvas: { width: 112, height: 72, zoom: 1 },
      container: { left: 0, top: 0, right: 112, bottom: 72, width: 112, height: 72 },
      child: { innerWidth: 112, innerHeight: 72, devicePixelRatio: 2 },
    });
    const unknown = parseNativeImageToolboxGeometry({
      canvas: { width: 112, height: NaN, zoom: 1 },
      container: { left: 0, top: 0, right: 112, bottom: 72, width: 112, height: 72 },
      child: { innerWidth: 112, innerHeight: 72, devicePixelRatio: 2 },
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.geometry.canvas.height).toBeNull();
  });

  it("ignores same-frame bridge messages until the matching opaque-origin report arrives", () => {
    const events = target();
    const pluginFrame = {} as MessageEventSource;
    const otherFrame = {} as MessageEventSource;
    const reports: unknown[] = [];
    listenForImageToolboxReport(events, () => pluginFrame, value => reports.push(value));

    events.emit({ source: otherFrame, origin: "null", data: reportMessage });
    events.emit({ source: pluginFrame, origin: "http://asset.localhost", data: reportMessage });
    events.emit({ source: pluginFrame, origin: "null", data: { kind: "__ipc_call__" } });
    expect(events.listeners.size).toBe(1);
    expect(reports).toEqual([]);

    events.emit({ source: pluginFrame, origin: "null", data: reportMessage });
    events.emit({ source: pluginFrame, origin: "null", data: reportMessage });
    expect(reports).toEqual([{ passed: true }]);
    expect(events.listeners.size).toBe(0);
  });

  it("disposes on caller timeout/send without accepting a late report", () => {
    const events = target();
    const pluginFrame = {} as MessageEventSource;
    const reports: unknown[] = [];
    const dispose = listenForImageToolboxReport(events, () => pluginFrame, value => reports.push(value));
    dispose();
    events.emit({ source: pluginFrame, origin: "null", data: reportMessage });
    expect(events.listeners.size).toBe(0);
    expect(reports).toEqual([]);
  });
});
