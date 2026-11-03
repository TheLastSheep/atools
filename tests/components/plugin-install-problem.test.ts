import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { presentPluginInstallProblem } from "../../src/lib/pluginInstallProblem";
import ZToolsSourceBuildStatus from "../../src/components/ZToolsSourceBuildStatus.svelte";

afterEach(() => cleanup());

describe("plugin install problem recovery", () => {
  it("explains a known runtime dependency failure and bounds raw details", () => {
    const raw = `[PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing first (preload/first.cjs) ${"详情".repeat(500)}`;
    const problem = presentPluginInstallProblem(raw, "market-install");
    expect(problem).toMatchObject({
      code: "PLUGIN_RUNTIME_DEPENDENCY_MISSING",
      title: "发布包缺少运行依赖",
      recovery: expect.stringContaining("包含运行依赖的发布包"),
    });
    expect(problem?.details).toContain("详情已省略");
    expect(problem?.details.length).toBeLessThan(620);
  });

  it("recognizes the exact existing artifact prefix only in install/build context", () => {
    expect(presentPluginInstallProblem("插件尚无可直接运行的本地产物：缺少 dist", "inventory-action")?.code)
      .toBe("PLUGIN_PACKAGE_ARTIFACT_MISSING");
    expect(presentPluginInstallProblem("缺少 dist", "market-install")).toBeNull();
    expect(presentPluginInstallProblem("安装插件失败：插件尚无可直接运行的本地产物：缺少 dist", "inventory-action"))
      .toMatchObject({ code: "PLUGIN_PACKAGE_ARTIFACT_MISSING", details: "安装插件失败：插件尚无可直接运行的本地产物：缺少 dist" });
    expect(presentPluginInstallProblem("更新插件失败：插件尚无可直接运行的本地产物：缺少 dist", "inventory-action")?.code)
      .toBe("PLUGIN_PACKAGE_ARTIFACT_MISSING");
    expect(presentPluginInstallProblem("卸载插件失败：插件尚无可直接运行的本地产物：缺少 dist", "inventory-action")).toBeNull();
  });

  it("does not classify open, unrelated, or unknown errors as package failures", () => {
    expect(presentPluginInstallProblem("PLUGIN_RUNTIME_DEPENDENCY_MISSING", "inventory-open")).toBeNull();
    expect(presentPluginInstallProblem("temporary network error", "market-install")).toBeNull();
  });

  it("caps displayed detail at 600 Unicode code points without splitting emoji", () => {
    const suffix = "…（详情已省略）";
    const raw = `[PLUGIN_RUNTIME_DEPENDENCY_MISSING] ${"😀".repeat(800)}`;
    const details = presentPluginInstallProblem(raw, "market-install")!.details;
    expect(Array.from(details).length).toBe(600 + Array.from(suffix).length);
    expect(details.endsWith(suffix)).toBe(true);
    expect(details.includes("\uFFFD")).toBe(false);
  });

  it("keeps source-build failure uncommitted while exposing the nested dependency cause", async () => {
    render(ZToolsSourceBuildStatus, {
      sourcePath: "/synthetic/source",
      entry: { phase: "failed", message: "SOURCE_BUILD_INSTALL_NOT_COMMITTED: [PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing lodash (preload/index.cjs)", observationError: "" },
      oninspect: () => {}, onconvert: () => {}, oncancel: () => {}, onresume: () => {}, onrescan: () => {},
    });
    expect(screen.getByRole("status").textContent).toContain("转换与安装未提交");
    expect(screen.getByText("发布包缺少运行依赖")).toBeTruthy();
    expect(screen.getByText(/请修复源码发布包中的运行依赖/)).toBeTruthy();
    expect(screen.getByText("重新检查转换")).toBeTruthy();
    const details = screen.getByText("技术详情").closest("details")!;
    expect(details.open).toBe(false);
    await fireEvent.click(screen.getByText("技术详情"));
    expect(details.open).toBe(true);
  });
});
