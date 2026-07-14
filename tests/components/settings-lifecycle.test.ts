import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsSaveLifecycleHarness from "./SettingsSaveLifecycleHarness.svelte";

afterEach(cleanup);

describe("settings save lifecycle", () => {
  it("flushes the latest pending settings exactly once when the component unmounts", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const view = render(SettingsSaveLifecycleHarness, { debouncer: { flush } });

    expect(flush).not.toHaveBeenCalled();
    view.unmount();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
