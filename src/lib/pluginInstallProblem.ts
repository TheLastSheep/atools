export type PluginInstallProblemContext = "market-install" | "inventory-action" | "inventory-open" | "source-build";
export type PluginInstallProblem = {
  code: "PLUGIN_RUNTIME_DEPENDENCY_MISSING" | "PLUGIN_PACKAGE_ARTIFACT_MISSING";
  title: string;
  message: string;
  recovery: string;
  details: string;
};

const DETAIL_LIMIT = 600;
const RUNTIME_DEPENDENCY = "PLUGIN_RUNTIME_DEPENDENCY_MISSING";
const BUILD_ARTIFACT_PREFIX = "插件尚无可直接运行的本地产物";

function boundedDetails(value: string): string {
  let end = 0;
  let visibleCodePoints = 0;
  while (end < value.length && visibleCodePoints < DETAIL_LIMIT) {
    const point = value.codePointAt(end)!;
    end += point > 0xffff ? 2 : 1;
    visibleCodePoints += 1;
  }
  const visible = value.slice(0, end);
  return end < value.length ? `${visible}…（详情已省略）` : visible;
}

/** Only recognizes stable install-time evidence; arbitrary errors stay in their existing flow. */
export function presentPluginInstallProblem(
  value: unknown,
  context: PluginInstallProblemContext,
): PluginInstallProblem | null {
  const raw = String(value ?? "");
  if (!raw) return null;

  if (context !== "inventory-open" && raw.includes(RUNTIME_DEPENDENCY)) {
    return {
      code: RUNTIME_DEPENDENCY,
      title: "发布包缺少运行依赖",
      message: "这个发布包的预加载脚本引用了未随包提供的运行依赖。",
      recovery: context === "source-build"
        ? "请修复源码发布包中的运行依赖，再使用“重新检查转换”。ATools 不会自动安装依赖。"
        : "请改选包含运行依赖的发布包，再重新确认安装或更新。ATools 不会自动安装依赖。",
      details: boundedDetails(raw),
    };
  }

  const isInstallContext = context === "market-install" || context === "inventory-action";
  const inventoryInstallMessage = context === "inventory-action"
    ? raw.replace(/^(?:安装插件失败|更新插件失败)：\s*/, "") : raw;
  const hasExactArtifactEvidence = inventoryInstallMessage.startsWith(BUILD_ARTIFACT_PREFIX);
  if (isInstallContext && hasExactArtifactEvidence) {
    return {
      code: "PLUGIN_PACKAGE_ARTIFACT_MISSING",
      title: "发布包没有可直接导入的产物",
      message: "当前选择的目录还不是可直接运行的插件发布目录。",
      recovery: context === "inventory-action"
        ? "请改选包含已构建文件的发布包后再安装或更新。需要导入本地发布包时，可用上方“安装本地插件”入口。"
        : "请改选包含已构建文件的发布包后再安装。",
      details: boundedDetails(raw),
    };
  }

  return null;
}
