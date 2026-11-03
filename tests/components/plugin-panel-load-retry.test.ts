import { describe, expect, it } from "vitest";
import { createPluginPanelLoadRetryController, type PluginPanelLoadRetrySnapshot } from "../../src/lib/pluginPanelLoadRetry";
import { pluginHostView } from "../../src/lib/pluginHostView";
import type { FeatureAction } from "../../src/lib/types";

const action: FeatureAction = { plugin_id: "retry-fixture", plugin_name: "重试工具", feature_code: "retry", main_url: "index.html", plugin_path: "/fixture/retry", expand_height: 400, payload: null };

function controller() {
  const changes: PluginPanelLoadRetrySnapshot[] = [];
  const retry = createPluginPanelLoadRetryController(state => changes.push(state));
  return { retry, changes };
}

describe("plugin panel load retry ownership", () => {
  it("allows exactly one explicit retry token for the current failed generation", () => {
    const { retry, changes } = controller();
    expect(retry.beginAutomatic(1)).toBe(true);
    expect(retry.fail(1, "HTML read failed")).toBe(true);
    const token = retry.requestRetry(1);
    expect(token).not.toBeNull();
    expect(retry.requestRetry(1)).toBeNull();
    expect(retry.snapshot()).toMatchObject({ generation: 1, phase: "retrying", error: "HTML read failed", retryable: true, busy: true });
    expect(retry.beginRetry(2, token!)).toBe(true);
    expect(retry.fail(2, "preload read failed")).toBe(true);
    expect(retry.snapshot()).toMatchObject({ generation: 2, phase: "failed", error: "preload read failed", retryable: true, busy: false });
    expect(changes.map(change => change.phase)).toEqual(["loading", "failed", "retrying", "retrying", "failed"]);
  });

  it("lets an action switch supersede a pending retry and ignores its stale token and completion", () => {
    const { retry } = controller();
    retry.beginAutomatic(1);
    retry.fail(1, "first load failed");
    const staleToken = retry.requestRetry(1)!;

    expect(retry.beginAutomatic(2)).toBe(true);
    expect(retry.beginRetry(3, staleToken)).toBe(false);
    expect(retry.fail(1, "late first failure")).toBe(false);
    expect(retry.succeed(2)).toBe(true);
    expect(retry.snapshot()).toMatchObject({ generation: 2, phase: "ready", error: null, busy: false });
  });

  it("keeps a terminal document failure closed to retry and ignores stale terminal callbacks", () => {
    const { retry } = controller();
    retry.beginAutomatic(7);
    expect(retry.terminal(7, "document revoked")).toBe(true);
    expect(retry.requestRetry(7)).toBeNull();
    expect(retry.fail(7, "late startup catch")).toBe(false);
    expect(retry.snapshot()).toMatchObject({ phase: "terminal", retryable: false, error: "document revoked" });
    expect(retry.invalidate(8)).toBe(true);
    expect(retry.snapshot()).toMatchObject({ generation: 8, phase: "closed", error: null, retryable: false });
  });

  it("does not convert an already ready generation into a retryable startup failure", () => {
    const { retry } = controller();
    expect(retry.beginAutomatic(4)).toBe(true);
    expect(retry.succeed(4)).toBe(true);
    expect(retry.fail(4, "post-ready diagnostic rejected")).toBe(false);
    expect(retry.requestRetry(4)).toBeNull();
    expect(retry.snapshot()).toMatchObject({ phase: "ready", error: null, retryable: false, busy: false });
  });

  it("keeps the body in retrying mode only after the new frame is staged", () => {
    const initialError = pluginHostView(action, { subInputVisible: false, iframeReady: false, outputItems: [], selectedIndex: 0, loadError: "HTML read failed", retryBusy: true });
    expect(initialError.bodyMode).toBe("error");
    expect(initialError.runtimeChips[0]?.detail).toBe("查看插件加载错误信息");
    const view = pluginHostView(action, { subInputVisible: false, iframeReady: true, outputItems: [], selectedIndex: 0, loadError: "HTML read failed", retryBusy: true });
    expect(view.bodyMode).toBe("retrying");
    expect(view.runtimeChips[0]?.detail).toBe("正在重新加载当前插件");
  });
});
