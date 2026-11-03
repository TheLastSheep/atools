import { mount, unmount } from "svelte";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativeMainPushScenario } from "./nativeMainPushScenario";
import { bounded, invoke, pause, phase, phaseErrors, type Fixture } from "./nativeMainPushSupport";

if (window === window.top) void (async () => {
  let application: ReturnType<typeof mount> | undefined;
  let report: Record<string, unknown> = { passed: false };
  try {
    await phase("frontend-entry");
    const fixture = await invoke<Fixture>("native_main_push_fixture");
    await phase("fixture-ready");
    localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false,
      localLaunchSearch: false, pluginEscapeToSearch: true }));
    application = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
    await phase("app-mounted");
    report = await runNativeMainPushScenario(fixture);
    await phase("scenario-complete");
  } catch (error) { report.error = String(error instanceof Error ? error.stack : error); }
  finally {
    await phase("unmount-start");
    if (application) try { await bounded(unmount(application), 10000, "unmount"); }
    catch (error) { report.passed = false; report.unmountError = String(error); }
    await phase("unmount-complete");
    let drained = false;
    const deadline = performance.now() + 5000;
    try {
      while (performance.now() < deadline) {
        const state = await bounded(invoke<{ drained: boolean }>("native_main_push_state"),
          Math.max(1, deadline - performance.now()), "runtime-drain");
        report.afterUnmount = state;
        if (state.drained) { drained = true; break; }
        await pause(50);
      }
    } catch (error) { report.passed = false; report.drainError = String(error); }
    report.frontendDrained = drained;
    if (!drained) { report.passed = false; report.unmountResourceError = "Frontend unmount did not release its runtime within five seconds"; }
    await phase("frontend-drain-complete");
    report.phaseErrors = [...phaseErrors];
    await invoke("native_main_push_report", { report });
  }
})();
