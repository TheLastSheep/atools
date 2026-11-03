import { describe, expect, it, vi } from "vitest";
import { createRendererGeneralSettingsClient } from "../../packages/ztools-renderer/src/generalSettingsClient";

function replies(initialRaw: string, committedRaw: string) {
  return {
    load: vi.fn(async () => ({ version: 1, raw: initialRaw })),
    mutate: vi.fn(async () => ({ version: 1, raw: committedRaw, notificationDelivered: true })),
  };
}

describe("ZTools renderer General receipt canonicalization", () => {
  it("compares nested JSON objects without depending on key insertion order", async () => {
    const initialRaw = '{"theme":"light","other":{"outer":1,"nested":{"b":2,"a":1}}}';
    const committedRaw = '{"other":{"nested":{"a":1,"b":2},"outer":1},"theme":"dark"}';
    const native = replies(initialRaw, committedRaw);
    const client = createRendererGeneralSettingsClient(native);

    await expect(client.save({ theme: "dark" })).resolves.toMatchObject({
      snapshot: { theme: "dark", other: { outer: 1, nested: { a: 1, b: 2 } } },
      notificationDelivered: true,
    });
    expect(client.snapshot().committedWrites).toBe(1);
    client.dispose();
  });

  it("continues rejecting non-finite nested receipt numbers", async () => {
    const native = replies(
      '{"theme":"light","other":{"count":1e400}}',
      '{"theme":"dark","other":{"count":1e400}}',
    );
    const onCommitted = vi.fn();
    const client = createRendererGeneralSettingsClient({ ...native, onCommitted });

    await expect(client.save({ theme: "dark" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ committedWrites: 0, saveFailures: 1 });
    client.dispose();
  });

  it("keeps undefined, accessor, and array writes rejected before native reads", async () => {
    const native = replies("null", "null");
    const client = createRendererGeneralSettingsClient(native);
    const accessor = Object.defineProperty({}, "theme", {
      enumerable: true,
      get: () => "dark",
    });

    for (const input of [
      { theme: undefined },
      accessor,
      ["dark"],
    ]) {
      await expect(client.save(input as Record<string, unknown>)).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
      });
    }
    expect(native.load).not.toHaveBeenCalled();
    expect(native.mutate).not.toHaveBeenCalled();
    client.dispose();
  });
});
