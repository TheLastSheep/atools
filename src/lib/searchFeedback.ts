export type RemoteSearchStatus = "idle" | "searching" | "ready" | "error" | "unavailable";

export type SearchFeedbackMode = "none" | "loading" | "empty" | "error" | "strip";

export type SearchFeedback = {
  mode: SearchFeedbackMode;
  title: string;
  hint: string;
  showSpinner: boolean;
};

export type SearchFeedbackInput = {
  query: string;
  resultCount: number;
  remoteStatus: RemoteSearchStatus;
  error?: string;
};

export function searchFeedbackFor(input: SearchFeedbackInput): SearchFeedback {
  const query = input.query.trim();
  if (!query) return feedback("none", "", "");

  if (input.remoteStatus === "searching") {
    if (input.resultCount > 0) {
      return feedback(
        "strip",
        "正在补充插件结果",
        "已显示本地匹配，插件搜索完成后会自动合并",
        true,
      );
    }
    return feedback(
      "loading",
      `正在搜索 “${query}”`,
      "正在匹配系统命令、网页快开、本地启动和插件指令",
      true,
    );
  }

  if (input.remoteStatus === "error") {
    const error = input.error?.trim() || "未知错误";
    if (input.resultCount > 0) {
      return feedback("strip", "插件搜索失败，已显示本地结果", error);
    }
    return feedback("error", "插件搜索失败", `已完成本地匹配，但插件搜索返回错误：${error}`);
  }

  if (input.resultCount > 0) return feedback("none", "", "");

  if (input.remoteStatus === "unavailable") {
    return feedback(
      "empty",
      `没有找到本地匹配 “${query}”`,
      "浏览器预览仅搜索系统命令、网页快开和本地启动；桌面应用会继续搜索插件",
    );
  }

  return feedback(
    "empty",
    `没有找到匹配 “${query}” 的命令`,
    "输入 “>” 可查看系统命令，或检查网页快开、本地启动配置",
  );
}

function feedback(mode: SearchFeedbackMode, title: string, hint: string, showSpinner = false): SearchFeedback {
  return { mode, title, hint, showSpinner };
}
