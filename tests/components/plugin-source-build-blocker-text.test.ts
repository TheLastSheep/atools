import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import ZToolsSourceBuildStatus from "../../src/components/ZToolsSourceBuildStatus.svelte";
import { sourceBuildBlockerText } from "../../src/lib/pluginSourceBuildBlockerText";

afterEach(() => cleanup());

const supportedMessage = "当前项目使用的 TSX 工具链版本或目录布局暂未支持。当前已验收 TSX 4.23.1 工具链布局。";
const nextStep = "若已有已构建的插件包，可以直接导入；也可以在本机准备受支持且与 lockfile 一致的工具链，再重新检查。";
const typecheckMessage = "当前项目的 TypeScript 检查配置无法安全用于自动转换。";
const typecheckNextStep = "请使用项目原有构建流程完成类型检查和打包，再导入已构建的插件包。";

it("explains the exact unsupported-toolchain code with the verified support and next steps", () => {
  expect(sourceBuildBlockerText({ code: "build_toolchain_unsupported", message: "internal generic blocker" })).toEqual({
    message: supportedMessage, guidance: nextStep,
  });
});

it("maps unsupported bare typecheck configuration to the existing build-then-import route", () => {
  expect(sourceBuildBlockerText({ code: "bare_typecheck_config_unsupported", message: "internal config reason" })).toEqual({
    message: typecheckMessage, guidance: typecheckNextStep,
  });
  expect(`${typecheckMessage} ${typecheckNextStep}`).not.toContain("bare_typecheck_config_unsupported");
  expect(`${typecheckMessage} ${typecheckNextStep}`).not.toContain("noEmit");
});

it("preserves unknown blocker messages verbatim", () => {
  const original = "原始诊断内容保持不变";
  expect(sourceBuildBlockerText({ code: "future_blocker", message: original })).toEqual({ message: original });
});

it("renders the typecheck blocker without exposing internal configuration details or enabling conversion", () => {
  render(ZToolsSourceBuildStatus, {
    entry: {
      phase: "blocked",
      inspection: { status: "blocked", blockers: [
        { code: "bare_typecheck_config_unsupported", message: "bare_typecheck_config_unsupported" },
      ] },
      message: "", observationError: "",
    },
    oninspect: vi.fn(), onconvert: vi.fn(), oncancel: vi.fn(), onrescan: vi.fn(),
  });
  expect(screen.getByText(typecheckMessage)).toBeTruthy();
  expect(screen.getByText(typecheckNextStep)).toBeTruthy();
  expect(screen.queryByText("bare_typecheck_config_unsupported")).toBeNull();
  expect(screen.getByRole("button", { name: "重新检查转换" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
});

it("shows toolchain guidance without masking a separate unsafe-source blocker", () => {
  render(ZToolsSourceBuildStatus, {
    entry: {
      phase: "blocked",
      inspection: { status: "blocked", blockers: [
        { code: "build_toolchain_unsupported", message: "internal generic blocker" },
        { code: "source_scan_unsafe", message: "Project source metadata changed during confined inspection or contains a symlink" },
      ] },
      message: "", observationError: "",
    },
    oninspect: vi.fn(), onconvert: vi.fn(), oncancel: vi.fn(), onresume: vi.fn(), onrescan: vi.fn(),
  });
  expect(screen.getByText(supportedMessage)).toBeTruthy();
  expect(screen.getByText(nextStep)).toBeTruthy();
  expect(screen.getByText("Project source metadata changed during confined inspection or contains a symlink")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新检查转换" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "一键转换并安装" })).toBeNull();
});
