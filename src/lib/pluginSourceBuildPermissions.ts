import type { PendingAgentToolRequest } from "./types";

/** A builtin's exact name and scope set select wording; plugin-supplied names cannot impersonate it. */
export function sourceBuildPermissionPresentation(request: PendingAgentToolRequest) {
  const convert = request.tool_name === "convert_ztools_plugin";
  const inspect = request.tool_name === "inspect_ztools_source_build";
  const expected = convert ? ["file_read", "file_write", "shell"] : ["file_read"];
  if ((!convert && !inspect) || request.scopes.length !== expected.length
    || !expected.every(scope => request.scopes.filter(value => value === scope).length === 1)) return null;
  const input = request.arguments as Record<string, unknown> | null;
  const path = typeof input?.sourcePath === "string" ? input.sourcePath : "所选项目";
  return {
    title: convert ? "转换并安装本地插件" : "检查本地插件项目",
    mode: convert ? "后台转换" : "仅检查",
    sourceLabel: request.client_id === "atools-ui" ? "ATools" : request.client_id,
    arguments: [{ key: "项目目录", value: path }, ...(convert
      ? [{ key: "同名插件", value: input?.overwrite === true ? "验证新产物后替换" : "保留现有插件" }] : [])],
    riskHints: convert
      ? ["会运行所选项目的构建代码，并安装验证后的插件产物。", "可能包含类型检查、测试、打包和本地构建脚本；实际顺序见所选项目的检查步骤。", "仅使用已有本地依赖，不会自动下载或安装依赖。"]
      : ["读取所选项目，检查构建所需文件；不会运行构建脚本。"],
    retryHint: convert ? "允许后在后台转换，关闭此面板不会中断任务；可在结果中心查看。" : "检查完成后会列出可转换状态或具体缺少的条件。",
  };
}
