import { describe, expect, it, vi } from "vitest";
import { createRendererSettingsViewClient } from "../../packages/ztools-renderer/src/settingsViewClient";
import { parseRendererSettingsViewEvent } from "../../packages/ztools-renderer/src/settingsViewProtocol";

const EVENT = "atools://renderer-settings-view";
const AUTO = { version: 1, phase: "auto-back-to-search" };
const ID = "00000000000040008000000000000001";

function fixture() {
  let deliver: ((payload: unknown) => void) | undefined;
  let resolveOpen!: (value: unknown) => void;
  const unlisten = vi.fn();
  const invoke = vi.fn(() => new Promise<unknown>((resolve) => { resolveOpen = resolve; }));
  const listen = vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    expect(event).toBe(EVENT);
    deliver = handler;
    return unlisten;
  });
  const client = createRendererSettingsViewClient({ invoke, transport: { listen } });
  const back = vi.fn();
  client.subscribe("onBackToSearch", back);
  return {
    client, invoke, listen, unlisten, back,
    emit: (value: unknown) => deliver?.(value),
    resolve: (value: unknown) => resolveOpen(value),
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("native automatic return through the existing original-renderer callback", () => {
  it("accepts only the exact native automatic-return envelope without a fabricated session", () => {
    expect(parseRendererSettingsViewEvent(AUTO)).toEqual(AUTO);
    const accessor = Object.defineProperty({ version: 1 }, "phase", {
      enumerable: true, get() { throw new Error("must not execute"); },
    });
    for (const value of [
      { ...AUTO, version: 2 }, { ...AUTO, sessionId: ID }, { ...AUTO, plugin: {} },
      { ...AUTO, [Symbol()]: true }, { phase: AUTO.phase }, accessor,
      Object.create(AUTO), { ...AUTO, phase: "back-to-search" },
    ]) expect(() => parseRendererSettingsViewEvent(value)).toThrow();
  });

  it("delivers while already searching with one existing listener and no extra IPC", async () => {
    const f = fixture();
    await settle();
    f.emit(AUTO);
    expect(f.back).toHaveBeenCalledTimes(1);
    expect(f.listen).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.client.snapshot().activePhase).toBeNull();
    expect(f.client.snapshot().invalidPayloads).toBe(0);
    f.client.dispose();
    f.emit(AUTO);
    expect(f.back).toHaveBeenCalledTimes(1);
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });

  it("cannot use an unscoped late return to close an opening or active settings document", async () => {
    const f = fixture();
    await settle();
    f.client.open();
    await settle();
    f.emit(AUTO);
    expect(f.back).not.toHaveBeenCalled();
    f.resolve({ version: 1, sessionId: ID });
    await settle();
    f.emit(AUTO);
    expect(f.back).not.toHaveBeenCalled();
    f.emit({ version: 1, sessionId: ID, phase: "placeholder" });
    f.emit({ version: 1, sessionId: ID, phase: "closed" });
    f.emit({ version: 1, sessionId: ID, phase: "back-to-search" });
    expect(f.back).toHaveBeenCalledTimes(1);
    f.emit(AUTO);
    expect(f.back).toHaveBeenCalledTimes(2);
    f.client.dispose();
  });

  it("keeps stale scoped events rejected and counts malformed automatic-return payloads", async () => {
    const f = fixture();
    await settle();
    f.emit({ version: 1, phase: "back-to-search", sessionId: ID });
    expect(f.back).not.toHaveBeenCalled();
    f.emit({ ...AUTO, sessionId: ID });
    expect(f.client.snapshot().invalidPayloads).toBe(1);
    expect(f.back).not.toHaveBeenCalled();
    f.client.dispose();
  });

  it("accepts automatic return after confirmed closure while retaining the old scoped close fence", async () => {
    const f = fixture();
    await settle();
    f.client.open();
    await settle();
    f.resolve({ version: 1, sessionId: ID });
    await settle();
    f.emit({ version: 1, sessionId: ID, phase: "placeholder" });
    f.client.close("main-hide");
    await settle();
    f.emit({ version: 1, sessionId: ID, phase: "closed" });
    f.emit({ version: 1, sessionId: ID, phase: "back-to-search" });
    expect(f.back).not.toHaveBeenCalled();
    f.emit(AUTO);
    expect(f.back).toHaveBeenCalledTimes(1);
    f.client.dispose();
  });
});
