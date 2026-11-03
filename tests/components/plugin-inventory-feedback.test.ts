import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { PluginInventoryController, type PluginInventoryControllerState, type PluginInventoryServices } from "../../src/lib/pluginInventoryController";
import { pluginInventoryFeedback, type PluginInventoryMessageKind } from "../../src/lib/pluginInventoryFeedback";
import PluginInventoryFeedbackNotice from "../../src/components/PluginInventoryFeedback.svelte";

const source = (messageKind: PluginInventoryMessageKind, message = "任意反馈文字") => ({ messageKind, message, error: "", refreshError: "" });
afterEach(() => cleanup());

function inventoryFixture() {
  return { id: "fixture.imported", name: "fixture", version: "1.0.0", path: "/plugins/fixture.imported", enabled: false, source_kind: "imported" as const,
    manifest: { title: "测试插件", permissions: [], features: [{ code: "main" }] }, created_at: "2026-01-01", updated_at: "2026-01-01" };
}

function failingServices(error: Error): PluginInventoryServices {
  return { available: () => true, listPlugins: async () => [], chooseDirectory: async () => "/picked/plugin",
    installDirectory: async () => { throw error; }, updateDirectory: async () => { throw error; }, togglePlugin: async () => {},
    authorizePlugin: async () => { throw error; }, uninstallPlugin: async () => {}, revealPath: async () => {}, confirm: async () => true };
}

describe("plugin inventory feedback presentation", () => {
  it("uses semantic intent instead of the language or contents of the message", () => {
    expect(pluginInventoryFeedback(source("read-success", "Catalogue loaded"))).toMatchObject({ visibility: "announcement", kind: "read-success" });
    expect(pluginInventoryFeedback(source("warning", "已读取 1 个插件"))).toMatchObject({ visibility: "visible", tone: "warning" });
  });

  it.each(["progress", "action-success", "cancelled", "warning", "read-failure", "readback-recovery", "action-failure"] as const)("keeps %s visible", kind => {
    expect(pluginInventoryFeedback(source(kind))?.visibility).toBe("visible");
  });

  it("keeps error observations visible even alongside an ordinary read announcement", () => {
    expect(pluginInventoryFeedback({ ...source("read-success"), refreshError: "read failed" })).toMatchObject({ visibility: "visible", tone: "error", retryList: true });
    expect(pluginInventoryFeedback({ ...source("read-success"), error: "action failed" })).toMatchObject({ visibility: "visible", tone: "error" });
    expect(pluginInventoryFeedback(source("read-success"), "opening failed")).toMatchObject({ visibility: "visible", kind: "open-failure", messages: ["任意反馈文字", "opening failed"] });
  });

  it("keeps committed readback recovery and its retry action visible", () => {
    expect(pluginInventoryFeedback({ ...source("readback-recovery"), refreshError: "db busy" })).toMatchObject({ visibility: "visible", tone: "warning", retryList: true });
    expect(pluginInventoryFeedback(source("none", ""))).toBeNull();
  });

  it("shows package recovery only for explicit action failures, never for open failures", () => {
    const actionFailure = pluginInventoryFeedback({ ...source("action-failure", "安装未完成"), error: "[PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing module" });
    render(PluginInventoryFeedbackNotice, { feedback: actionFailure, nativeAvailable: true, readDisabled: false, onretry: () => {} });
    expect(screen.getByText("发布包缺少运行依赖")).toBeTruthy();
    expect(screen.getByText(/安装本地插件/)).toBeTruthy();
    cleanup();
    const openFailure = pluginInventoryFeedback(source("none"), "PLUGIN_RUNTIME_DEPENDENCY_MISSING");
    render(PluginInventoryFeedbackNotice, { feedback: openFailure, nativeAvailable: true, readDisabled: false, onretry: () => {} });
    expect(screen.queryByText("发布包缺少运行依赖")).toBeNull();
    expect(screen.getByText("PLUGIN_RUNTIME_DEPENDENCY_MISSING")).toBeTruthy();
  });

  it.each(["install", "update"] as const)("maps a real controller %s failure into one accessible recovery announcement", async action => {
    const rawError = "插件尚无可直接运行的本地产物：发布目录缺少可直接运行文件";
    let current!: PluginInventoryControllerState;
    const controller = new PluginInventoryController(failingServices(new Error(rawError)), state => { current = state; }, [inventoryFixture()]);
    if (action === "install") await controller.install();
    else await controller.update("fixture.imported");

    const feedback = pluginInventoryFeedback({ message: current.message, messageKind: current.messageKind, error: current.error, refreshError: current.refreshError });
    render(PluginInventoryFeedbackNotice, { feedback, nativeAvailable: true, readDisabled: false, onretry: () => {} });
    expect(screen.getByText("发布包没有可直接导入的产物")).toBeTruthy();
    expect(document.querySelector('[aria-label="安装问题与处理建议"] p:last-of-type')?.textContent)
      .toContain("请改选包含已构建文件的发布包");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).not.toContain(rawError);
    expect(document.querySelector("[data-feedback-kind='action-failure']")?.hasAttribute("aria-live")).toBe(false);
    await fireEvent.click(screen.getByText("技术详情"));
    const details = document.querySelector("pre")?.textContent ?? "";
    expect(details).toContain(rawError);
    expect(details.startsWith("安装插件失败：") || details.startsWith("更新插件失败：")).toBe(true);
  });
});
