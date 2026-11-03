import { afterEach, describe, expect, it } from "vitest";
import { originalGeometryFunctions, originalGeometryWindow, settle } from "./originalWindowGeometryFixture";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
async function fixture() { const value = await originalGeometryWindow(); disposers.push(value.dispose); return value; }
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("unchanged original BrowserWindow geometry calling patterns", () => {
  it("returns numeric typing settings information through the actual production facade with no getter IPC", async () => {
    const original = await originalGeometryFunctions(), f = await fixture();
    const count = f.calls.length;
    expect(plain(original.typing(f.handle))).toEqual({ size: { w: 640, h: 360 }, pos: { x: -40, y: 20 } });
    expect(f.handle.getBounds()).not.toHaveProperty("then");
    expect(f.calls.length).toBe(count);
    expect(f.errors).toEqual([]);
  });

  it("keeps the original paintbrush drag math finite and preserves dimensions", async () => {
    const original = await originalGeometryFunctions(), f = await fixture();
    original.paintbrush("floater:move", f.handle, { dx: 12.4, dy: -3.6 });
    await settle();
    const calls = f.calls.filter(call => call.method === "browserWindowAction");
    expect(calls).toHaveLength(1);
    expect(calls[0].args.action).toBe("setBounds");
    expect(plain(calls[0].args.args[0])).toEqual({ x: -28, y: 16, width: 640, height: 360 });
    expect(plain(f.handle.getBounds())).toEqual({ x: -40, y: 20, width: 640, height: 360 });
    Object.assign(f.state, calls[0].args.args[0]);
    f.host.publish(f.state); f.respond(calls[0], null); await settle();
    original.paintbrush("floater:move", f.handle, { dx: 10, dy: 7 }); await settle();
    expect(plain(f.calls.at(-1).args.args[0])).toEqual({ x: -18, y: 23, width: 640, height: 360 });
    f.respond(f.calls.at(-1), null); await settle();
  });

  it("runs original minimum resize rules and reads host-confirmed geometry after acknowledgement", async () => {
    const original = await originalGeometryFunctions(), f = await fixture();
    original.paintbrush("floater:resize", f.handle, { width: 200.5, height: 100, x: -70.4 }); await settle();
    const call = f.calls.find(call => call.args?.action === "setBounds");
    expect(plain(call.args.args[0])).toEqual({ x: -70, y: 20, width: 420, height: 180 });
    expect(plain(original.typing(f.handle))).toEqual({ size: { w: 640, h: 360 }, pos: { x: -40, y: 20 } });
    Object.assign(f.state, call.args.args[0]); f.host.publish(f.state); f.respond(call, null); await settle();
    expect(plain(original.typing(f.handle))).toEqual({ size: { w: 420, h: 180 }, pos: { x: -70, y: 20 } });
  });

  it("does not invent confirmed state or hide rejection while a mutation awaits the host", async () => {
    const f = await fixture(), pending = f.handle.setBounds({ x: 123, y: 456, width: 700, height: 500 });
    const rejected = expect(pending).rejects.toThrow("Permission denied");
    await settle();
    expect(plain(f.handle.getPosition())).toEqual([-40, 20]);
    f.respond(f.calls.find(call => call.args?.action === "setBounds"), undefined, "Permission denied");
    await rejected;
    expect(plain(f.handle.getBounds())).toEqual({ x: -40, y: 20, width: 640, height: 360 });
  });
});
