export type SourceBuildBlockerText = { message: string; guidance?: string };

const unsupportedToolchain = {
  message: "当前项目使用的 TSX 工具链版本或目录布局暂未支持。当前已验收 TSX 4.23.1 工具链布局。",
  guidance: "若已有已构建的插件包，可以直接导入；也可以在本机准备受支持且与 lockfile 一致的工具链，再重新检查。",
};

const unsupportedBareTypecheckConfig = {
  message: "当前项目的 TypeScript 检查配置无法安全用于自动转换。",
  guidance: "请使用项目原有构建流程完成类型检查和打包，再导入已构建的插件包。",
};

export function sourceBuildBlockerText(blocker: { code: string; message: string }): SourceBuildBlockerText {
  if (blocker.code === "build_toolchain_unsupported") return unsupportedToolchain;
  if (blocker.code === "bare_typecheck_config_unsupported") return unsupportedBareTypecheckConfig;
  return { message: blocker.message };
}
