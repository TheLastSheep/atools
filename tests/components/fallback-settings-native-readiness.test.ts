import { describe, expect, it } from "vitest";
import {
  dispatchDomClick,
  dispatchNativeInput,
  isLaunchControlReady,
  sampleLaunchControl,
  waitForKnownLaunchState,
} from "./fallbackSettingsNativeReadiness";

describe("fallback settings launch control readiness", () => {
  it("waits for delayed OS state, then samples the actual DOM control", async () => {
    document.body.innerHTML = `
      <section class="settings-panel">
        <input type="checkbox" aria-label="开机自动启动" aria-checked="mixed" disabled />
      </section>
    `;
    const control = document.querySelector<HTMLInputElement>('input[aria-label="开机自动启动"]')!;
    control.indeterminate = true;
    const initial = sampleLaunchControl(document);
    expect(initial).toMatchObject({ ready: true, controlUnique: true, enabled: null, disabled: true, indeterminate: true });
    expect(isLaunchControlReady(initial)).toBe(false);

    setTimeout(() => {
      control.indeterminate = false;
      control.disabled = false;
      control.checked = true;
      control.setAttribute("aria-checked", "true");
    }, 40);

    const startedAt = performance.now();
    const observed = await waitForKnownLaunchState(() => sampleLaunchControl(document), startedAt + 750);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(observed).toMatchObject({ ready: true, controlUnique: true, enabled: true, disabled: false, indeterminate: false });
    expect(isLaunchControlReady(observed)).toBe(true);
  });

  it("returns the last unknown sample when the bounded readiness deadline expires", async () => {
    document.body.innerHTML = `
      <section class="settings-panel">
        <input type="checkbox" aria-label="开机自动启动" aria-checked="mixed" disabled />
      </section>
    `;
    const startedAt = performance.now();
    const observed = await waitForKnownLaunchState(() => sampleLaunchControl(document), startedAt + 75);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(observed.enabled).toBeNull();
    expect(observed.disabled).toBe(true);
    expect(isLaunchControlReady(observed)).toBe(false);
  });

  it("keeps missing DOM evidence unknown and records whether real DOM actions were dispatched", () => {
    document.body.innerHTML = "";
    expect(sampleLaunchControl(document)).toEqual({
      ready: false,
      controlUnique: null,
      enabled: null,
      disabled: null,
      indeterminate: null,
    });
    expect(isLaunchControlReady(sampleLaunchControl(document))).toBe(false);
    expect(dispatchDomClick(null)).toBe(false);
    expect(dispatchNativeInput(null, "value")).toEqual({ dispatched: false, valueObserved: null });

    const emptyPanel = document.createElement("section");
    emptyPanel.className = "settings-panel";
    document.body.append(emptyPanel);
    expect(sampleLaunchControl(document)).toEqual({
      ready: true,
      controlUnique: false,
      enabled: null,
      disabled: null,
      indeterminate: null,
    });
    emptyPanel.remove();

    const panel = document.createElement("section");
    panel.className = "settings-panel";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "开机自动启动");
    panel.append(checkbox);
    document.body.append(panel);
    expect(checkbox.isConnected).toBe(true);
    expect(checkbox.ownerDocument.defaultView).not.toBeNull();
    let clicks = 0;
    checkbox.addEventListener("click", () => { clicks += 1; });
    expect(dispatchDomClick(checkbox)).toBe(true);
    expect(clicks).toBe(1);

    const text = document.createElement("input");
    text.type = "text";
    panel.append(text);
    const events: string[] = [];
    text.addEventListener("input", () => events.push("input"));
    text.addEventListener("change", () => events.push("change"));
    expect(dispatchNativeInput(text, "actual DOM input")).toEqual({ dispatched: true, valueObserved: true });
    expect(events).toEqual(["input", "change"]);
  });
});
