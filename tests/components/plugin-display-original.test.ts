import { describe, expect, it } from "vitest";
import type { PluginDisplaySnapshot } from "../../src/lib/pluginDisplayBridge";
import { originalDisplayFixture } from "./originalDisplayFixture";
function snapshot(): PluginDisplaySnapshot {
  const display = (id: number, x: number, y: number, width: number, height: number, scaleFactor: number) => ({ id, bounds: { x, y, width, height },
    workArea: { x, y: y + 24, width, height: height - 24 }, size: { width, height }, workAreaSize: { width, height: height - 24 }, scaleFactor, rotation: 0, internal: id === 2 });
  return { schemaVersion: 1, platform: "darwin", primaryId: 2, cursor: { x: -200, y: -100 }, displays: [display(2, 0, 0, 1440, 900, 2), display(1, -1920, -200, 1920, 1080, 1)] };
}
describe("pinned original display function calls, generated windows only", () => {
  it("floating original image fitting observes the actual cursor display size", async () => {
    const fixture = await originalDisplayFixture("floating", snapshot()); await fixture.run();
    const created = fixture.calls.find(call => call.operation === "window"); expect(created.options.width).toBe(1536); expect(created.options.height).toBe(768);
    expect(fixture.reads).toHaveLength(2); expect(fixture.calls.some(call => call.operation === "permission")).toBe(false);
  });
  it.each(["lihua", "yanhua"] as const)("%s original overlay configuration uses negative native bounds", async kind => {
    const fixture = await originalDisplayFixture(kind, snapshot()); await fixture.run();
    expect(fixture.calls.find(call => call.operation === "window").options).toMatchObject({ x: -1920, y: -200, width: 1920, height: 1080, fullscreen: false });
    expect(fixture.calls.filter(call => call.operation === "ignoreMouse")).toEqual([{ operation: "ignoreMouse", args: [true, { forward: true }] }]);
    expect(fixture.calls.some(call => call.operation === "notification")).toBe(false); expect(fixture.reads).toHaveLength(2);
  });
  it("shortcut capture original editor placement remains within the cursor's display", async () => {
    const fixture = await originalDisplayFixture("shortcut", snapshot()); await fixture.run();
    const options = fixture.calls.find(call => call.operation === "window").options;
    expect(options).toMatchObject({ x: -1624, y: -200, width: 1624, height: 982 });
    expect(options.x + options.width).toBeLessThanOrEqual(0); expect(options.y + options.height).toBeLessThanOrEqual(880);
    expect(fixture.storage.size).toBe(1); expect(fixture.reads).toHaveLength(2);
  });
  it("long screenshot original mask config queries native cursor once per initial creation", async () => {
    const fixture = await originalDisplayFixture("long", snapshot()); await fixture.run(); await fixture.run();
    expect(fixture.calls.filter(call => call.operation === "window")).toHaveLength(1);
    expect(fixture.calls.find(call => call.operation === "window").options).toMatchObject({ x: -1920, y: -200, width: 1920, height: 1080 });
    expect(fixture.reads).toHaveLength(2); expect(fixture.calls.find(call => call.operation === "alwaysOnTop").args).toEqual([true, "screen-saver", 2]);
    expect(fixture.reads.every(read => read.async === false && read.body === '{"operation":"snapshot"}')).toBe(true);
  });
});
