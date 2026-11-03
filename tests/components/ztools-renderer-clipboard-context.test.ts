import { expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

type Call = { command: RendererHostCommand; args?: Record<string, unknown> };
const timestamp = 1_798_000_000_000;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD7sAAAAASUVORK5CYII=";
const PNG_PREFIX = "data:image/png;base64,";

function createAdapter(reply: unknown, calls: Call[], invokeOverride?: (command: RendererHostCommand, args?: Record<string, unknown>) => Promise<unknown>) {
  const transport: ZToolsRendererTransport = {
    async invoke(command, args) {
      calls.push({ command, args });
      return invokeOverride ? invokeOverride(command, args) : command === "get_renderer_last_copied_content" ? reply : undefined;
    },
    async listen() { return () => undefined; },
  };
  return createZtoolsRendererHostAdapter({ transport });
}

function file(overrides: Record<string, unknown> = {}) {
  return { path: "/tmp/fixture.txt", name: "fixture.txt", isFile: true, isDirectory: false, ...overrides };
}

function invokeReader(adapter: ReturnType<typeof createAdapter>, ...args: unknown[]): Promise<unknown> {
  return Reflect.apply(adapter.api.getLastCopiedContent, adapter.api, args) as Promise<unknown>;
}

it("maps unlimited and fractional age limits to one native command", async () => {
  const calls: Call[] = [];
  const adapter = createAdapter(null, calls);
  expect(adapter.capabilities().methods.getLastCopiedContent).toBe("limited");
  await expect(adapter.api.getLastCopiedContent()).resolves.toBeNull();
  await expect(adapter.api.getLastCopiedContent(0)).resolves.toBeNull();
  await expect(adapter.api.getLastCopiedContent(-2)).resolves.toBeNull();
  await expect(adapter.api.getLastCopiedContent(12.5)).resolves.toBeNull();
  expect(calls).toEqual([
    { command: "get_renderer_last_copied_content", args: { timeLimit: null } },
    { command: "get_renderer_last_copied_content", args: { timeLimit: null } },
    { command: "get_renderer_last_copied_content", args: { timeLimit: null } },
    { command: "get_renderer_last_copied_content", args: { timeLimit: 12.5 } },
  ]);
  expect(adapter.snapshot().nativeCalls.get_renderer_last_copied_content).toBe(4);
  adapter.dispose();
});

it("rejects invalid limits before IPC and never coerces them", async () => {
  const calls: Call[] = [];
  const adapter = createAdapter(null, calls);
  for (const value of [null, "5", Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)]) {
    await expect(invokeReader(adapter, value)).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
  }
  expect(calls).toEqual([]);
  adapter.dispose();
});

it("returns the trusted Native text, PNG and file variants", async () => {
  const replies = [
    { type: "text", data: "多字节🧰 text", timestamp },
    { type: "text", data: "epoch", timestamp: 0 },
    { type: "image", data: PNG, timestamp },
    { type: "file", data: [file(), file({ path: "/tmp/folder", name: "folder", isFile: false, isDirectory: true })], timestamp },
    null,
  ];
  for (const reply of replies) {
    const calls: Call[] = [];
    const adapter = createAdapter(reply, calls);
    await expect(adapter.api.getLastCopiedContent()).resolves.toEqual(reply);
    expect(calls).toHaveLength(1);
    adapter.dispose();
  }
});

it("keeps exact envelope and cheap timestamp/type/length checks", async () => {
  const largeText = { type: "text", data: "x".repeat(10 * 1024 * 1024), timestamp };
  const imageAtLimit = `${PNG_PREFIX}${"A".repeat(8 * 1024 * 1024 - PNG_PREFIX.length)}`;
  const filesAtLimit = Array.from({ length: 1024 }, (_, index) => file({ name: `file-${index}` }));
  const accepted = [
    largeText,
    { type: "image", data: imageAtLimit, timestamp },
    { type: "file", data: filesAtLimit, timestamp },
  ];
  for (const reply of accepted) {
    const adapter = createAdapter(reply, []);
    await expect(adapter.api.getLastCopiedContent()).resolves.toMatchObject({ type: reply.type });
    adapter.dispose();
  }

  const getter = vi.fn(() => "x");
  const withGetter: Record<string, unknown> = { type: "text", timestamp };
  Object.defineProperty(withGetter, "data", { enumerable: true, get: getter });
  const withSymbol = { type: "text", data: "x", timestamp };
  Object.defineProperty(withSymbol, Symbol("extra"), { enumerable: true, value: true });
  const invalidReplies = [
    { type: "text", data: "x", timestamp, extra: true },
    withGetter,
    withSymbol,
    Object.assign(Object.create({ extra: true }), { type: "text", data: "x", timestamp }),
    { type: "text", data: "x".repeat(10 * 1024 * 1024 + 1), timestamp },
    { type: "text", data: "x", timestamp: -1 },
    { type: "text", data: "x", timestamp: 1.25 },
    { type: "text", data: "x", timestamp: "1" },
    { type: "text", data: "x", timestamp: null },
    { type: "text", data: "x", timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { type: "image", data: "data:image/jpeg;base64,AAAA", timestamp },
    { type: "image", data: `${PNG_PREFIX}${"A".repeat(8 * 1024 * 1024 - PNG_PREFIX.length + 1)}`, timestamp },
    { type: "file", data: [], timestamp },
    { type: "file", data: Array.from({ length: 1025 }, () => file()), timestamp },
    { type: "file", data: "not an array", timestamp },
    { type: "unsupported", data: "x", timestamp },
  ];
  for (const reply of invalidReplies) {
    const adapter = createAdapter(reply, []);
    await expect(adapter.api.getLastCopiedContent()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
    adapter.dispose();
  }
  expect(getter).not.toHaveBeenCalled();
});

it("uses the adapter active guard and prevents delivery from a late response", async () => {
  const beforeDispatchCalls: Call[] = [];
  const disposedBeforeDispatch = createAdapter(null, beforeDispatchCalls);
  const notStarted = disposedBeforeDispatch.api.getLastCopiedContent();
  disposedBeforeDispatch.dispose();
  await expect(notStarted).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
  expect(beforeDispatchCalls).toEqual([]);

  const calls: Call[] = [];
  let release!: (value: unknown) => void;
  const adapter = createAdapter(undefined, calls, () => new Promise((resolve) => { release = resolve; }));
  const pending = adapter.api.getLastCopiedContent();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  adapter.dispose();
  release({ type: "text", data: "late", timestamp });
  await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
  expect(adapter.snapshot().outstandingNativeCalls).toBe(0);
});
