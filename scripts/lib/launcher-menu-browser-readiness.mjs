/**
 * Uses actual browser target activation before asserting focus. This does not
 * emulate document focus and makes no claim about macOS window/input behavior.
 */
export async function navigateFocusedLauncherFixture(page, { url, evaluate, waitFor }) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 420, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const domContentLoaded = page.waitForEvent("Page.domContentEventFired", 15000);
  await page.send("Page.navigate", { url });
  await domContentLoaded;
  await waitFor(page, "document.readyState==='interactive'||document.readyState==='complete'", "real DOMContentLoaded state");
  const state = "({focused:document.hasFocus(),visibility:document.visibilityState,ready:!!window.launcherFixtureReady})";
  const before = await evaluate(page, state);
  await page.send("Page.bringToFront");
  await waitFor(page, "document.hasFocus() && document.visibilityState==='visible' && window.launcherFixtureReady && document.querySelector('[role=combobox]')",
    "visible focused document and actual App fixture readiness");
  return { command: "Page.bringToFront", focusEmulation: false, before, after: await evaluate(page, state) };
}
