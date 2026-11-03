import { expect, it } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

it("accepts the Native launch-context limits and keeps the search query bound", () => {
  const calls: RendererHostCommand[] = [];
  const adapter = createZtoolsRendererHostAdapter({
    transport: {
      async invoke(command) {
        calls.push(command);
        throw new Error("launch context must remain renderer-local");
      },
      async listen(_event, _handler) { return () => undefined; },
    } satisfies ZToolsRendererTransport,
  });
  const context = {
    searchQuery: "q".repeat(8 * 1024),
    pastedImage: null,
    pastedFiles: Array.from({ length: 1024 }, (_, index) => ({
      path: `/tmp/file-${index}`,
      name: "n".repeat(1024),
      isDirectory: false,
    })),
    pastedText: "x".repeat(10 * 1024 * 1024),
  };

  expect(() => adapter.api.updateLaunchContext(context)).not.toThrow();
  expect(adapter.snapshot().launchContextSet).toBe(true);
  expect(() => adapter.api.updateLaunchContext({ ...context, searchQuery: `${context.searchQuery}q` }))
    .toThrow(/Invalid ZTools renderer input: searchQuery/);
  expect(() => adapter.api.updateLaunchContext({ ...context, pastedText: `${context.pastedText}x` }))
    .toThrow(/Invalid ZTools renderer input: pastedText/);
  expect(() => adapter.api.updateLaunchContext({
    ...context,
    pastedFiles: [...context.pastedFiles, { path: "/tmp/overflow", name: "overflow", isDirectory: false }],
  })).toThrow(/Invalid ZTools renderer input: pastedFiles/);
  expect(calls).toEqual([]);
  adapter.dispose();
});
