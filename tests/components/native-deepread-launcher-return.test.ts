import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDeepReadLauncherReturn } from "./nativeDeepReadLauncherReturn";

function context(maxAttempts = 4, afterMiss?: (attempt: number) => void) {
  const checks: Array<{ value: unknown; label: string }> = [];
  return {
    checks,
    until: async <T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const value = await read();
        if (value) return value as NonNullable<T>;
        afterMiss?.(attempt);
        await Promise.resolve();
      }
      throw Error(label);
    },
    check: (value: unknown, label: string) => {
      checks.push({ value, label });
      if (!value) throw Error(label);
    },
  };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("DeepRead production launcher return synchronization", () => {
  it("waits for panel removal, later input mount, and subsequent focus within one bounded wait", async () => {
    document.body.innerHTML = '<section class="plugin-panel"></section>';
    expect(document.querySelector(".plugin-panel")).not.toBeNull();
    expect(document.querySelector(".search-input")).toBeNull();
    const h = context(4, attempt => {
      if (attempt === 0) document.querySelector(".plugin-panel")?.remove();
      if (attempt === 1) {
        document.body.insertAdjacentHTML("beforeend", '<input class="search-input" aria-label="Launcher search">');
      }
      if (attempt === 2) document.querySelector<HTMLInputElement>(".search-input")?.focus();
    });
    const input = await waitForDeepReadLauncherReturn(h);
    expect(input).toBe(document.querySelector(".search-input"));
    expect(document.querySelector(".plugin-panel")).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(h.checks.map(item => item.label)).toEqual([
      "DeepRead launcher input is mounted", "DeepRead launcher input regained focus",
    ]);
  });

  it("runs the passive return callback after the same bounded wait on success and failure", async () => {
    document.body.innerHTML = '<section class="plugin-panel"></section>';
    const phases: string[] = [];
    const h = context(4, attempt => {
      if (attempt === 0) document.querySelector(".plugin-panel")?.remove();
      if (attempt === 1) document.body.insertAdjacentHTML("beforeend", '<input class="search-input">');
      if (attempt === 2) document.querySelector<HTMLInputElement>(".search-input")?.focus();
    });
    const input = await waitForDeepReadLauncherReturn({ ...h, passivePluginReturn: {
      markAttempted: () => phases.push("attempted"), observeSettled: async () => { phases.push("settled"); },
    } }, true);
    expect(input).toBe(document.querySelector(".search-input"));
    expect(phases).toEqual(["attempted", "settled"]);

    document.body.replaceChildren();
    document.body.innerHTML = '<section class="plugin-panel"></section>';
    const failedPhases: string[] = [];
    await expect(waitForDeepReadLauncherReturn({ ...context(2), passivePluginReturn: {
      markAttempted: () => failedPhases.push("attempted"), observeSettled: async () => { failedPhases.push("settled"); },
    } }, true)).rejects.toThrow("DeepRead panel did not return to the production launcher");
    expect(failedPhases).toEqual(["attempted", "settled"]);
  });

  it("fails within the supplied bounded wait when the launcher input never mounts", async () => {
    document.body.innerHTML = '<section class="plugin-panel"></section>';
    const h = context(3);
    await expect(waitForDeepReadLauncherReturn(h)).rejects.toThrow(
      "DeepRead panel did not return to the production launcher",
    );
    expect(h.checks).toEqual([]);
  });

  it("waits for panel removal even when the launcher input is already mounted", async () => {
    document.body.innerHTML = '<section class="plugin-panel"></section><input class="search-input" aria-label="Launcher search">';
    const input = document.querySelector<HTMLInputElement>(".search-input")!;
    input.focus();
    const h = context(3);
    await expect(waitForDeepReadLauncherReturn(h)).rejects.toThrow(
      "DeepRead panel did not return to the production launcher",
    );
    expect(document.querySelector(".plugin-panel")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(h.checks).toEqual([]);
  });

  it("fails within the same bounded wait when the mounted launcher input never regains focus", async () => {
    document.body.innerHTML = '<input class="search-input" aria-label="Launcher search"><button>Other</button>';
    const input = document.querySelector<HTMLInputElement>(".search-input")!;
    const h = context(3);
    await expect(waitForDeepReadLauncherReturn(h)).rejects.toThrow(
      "DeepRead panel did not return to the production launcher",
    );
    expect(document.querySelector(".plugin-panel")).toBeNull();
    expect(document.activeElement).not.toBe(input);
    expect(h.checks).toEqual([]);
  });

  it("accepts an already returned, focused launcher without extra polling", async () => {
    document.body.innerHTML = '<input class="search-input" aria-label="Launcher search">';
    const input = document.querySelector<HTMLInputElement>(".search-input")!;
    input.focus();
    const h = context();
    await expect(waitForDeepReadLauncherReturn(h)).resolves.toBe(input);
    expect(h.checks).toHaveLength(2);
  });
});
