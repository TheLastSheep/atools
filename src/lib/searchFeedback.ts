export type RemoteSearchStatus = "idle" | "searching" | "ready" | "partial" | "error" | "unavailable";

export type SearchFeedbackMode = "none" | "loading" | "empty" | "error" | "strip";

export type SearchFeedback = {
  mode: SearchFeedbackMode;
  title: string;
  hint: string;
  showSpinner: boolean;
  /** True only for a completed ordinary search failure with no usable result. */
  retryOnEnter?: boolean;
  /** True when a completed search failed some sources but still has usable results. */
  retryOnPointer?: boolean;
};

export type SearchFeedbackInput = {
  query: string;
  resultCount: number;
  remoteStatus: RemoteSearchStatus;
  error?: string;
};

export type SearchRetryKeyContext = {
  key: string;
  query: string;
  resultCount: number;
  feedback: SearchFeedback;
  isHomeSearch: boolean;
  isMainSearchFocused: boolean;
  hasTextOrMediaContext: boolean;
  modalOpen: boolean;
  isComposing: boolean;
  keyCode: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type SearchRetryEligibilityContext = Pick<
  SearchRetryKeyContext,
  "query" | "resultCount" | "feedback" | "isHomeSearch" | "hasTextOrMediaContext" | "modalOpen"
>;

function retryContextAllowed(input: SearchRetryEligibilityContext): boolean {
  return input.query.trim().length > 0
    && input.isHomeSearch
    && !input.hasTextOrMediaContext
    && !input.modalOpen;
}

/** Keyboard retry is reserved for completed failures with no result to activate. */
export function canRetrySearch(input: SearchRetryEligibilityContext): boolean {
  return retryContextAllowed(input)
    && input.resultCount === 0
    && input.feedback.retryOnEnter === true
}

/** Pointer or focused retry-button actions may rerun a failed query with retained results. */
export function canRetrySearchFromPointer(input: SearchRetryEligibilityContext): boolean {
  return retryContextAllowed(input)
    && ((input.resultCount === 0 && input.feedback.retryOnEnter === true)
      || (input.resultCount > 0 && input.feedback.retryOnPointer === true));
}

/** Gate retry to the focused, ordinary launcher search failure state. */
export function shouldRetrySearchOnEnter(input: SearchRetryKeyContext): boolean {
  return input.key === "Enter"
    && canRetrySearch(input)
    && input.isMainSearchFocused
    && !input.isComposing
    && input.keyCode !== 229
    && !input.metaKey
    && !input.ctrlKey
    && !input.altKey
    && !input.shiftKey;
}

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

  if (input.remoteStatus === "partial") {
    const canRetry = input.resultCount === 0;
    const hint = canRetry
      ? "当前没有可用结果。按 Enter 重试搜索。"
      : "已显示可用结果；可重试以补齐更多结果。";
    return feedback(input.resultCount > 0 ? "strip" : "error", "部分搜索结果暂不可用", hint,
      false, canRetry, input.resultCount > 0);
  }

  if (input.remoteStatus === "error") {
    if (input.resultCount > 0) {
      return feedback("strip", "搜索暂不可用", "已有结果仍可用；可重试搜索更多结果。", false, false, true);
    }
    return feedback("error", "搜索暂不可用", "当前没有可用结果。按 Enter 重试搜索。", false, true);
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

function feedback(mode: SearchFeedbackMode, title: string, hint: string, showSpinner = false,
  retryOnEnter = false, retryOnPointer = false): SearchFeedback {
  return {
    mode, title, hint, showSpinner,
    ...(retryOnEnter ? { retryOnEnter: true } : {}),
    ...(retryOnPointer ? { retryOnPointer: true } : {}),
  };
}
