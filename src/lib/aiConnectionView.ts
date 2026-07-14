import type { AiProvider } from "./settings";
import type { AiConnectionTestResult } from "./types";

export type AiConnectionButtonInput = {
  hasTauriRuntime: boolean;
  provider: AiProvider;
  configReady: boolean;
  testing: boolean;
};

export type AiConnectionButtonState = {
  disabled: boolean;
  label: string;
  reason: string;
};

export type AiConnectionRow = {
  label: string;
  value: string;
};

export function aiConnectionButtonState(input: AiConnectionButtonInput): AiConnectionButtonState {
  if (!input.hasTauriRuntime) {
    return {
      disabled: true,
      label: "测试连接",
      reason: "需在桌面应用中测试 AI 连接",
    };
  }

  if (input.provider === "disabled") {
    return {
      disabled: true,
      label: "测试连接",
      reason: "请先启用 AI 模型提供商",
    };
  }

  if (!input.configReady) {
    return {
      disabled: true,
      label: "测试连接",
      reason: "请填写 Base URL、默认模型和必要的 API Key",
    };
  }

  if (input.testing) {
    return {
      disabled: true,
      label: "测试中...",
      reason: "正在读取模型列表",
    };
  }

  return {
    disabled: false,
    label: "测试连接",
    reason: "读取 /models 并检查默认模型",
  };
}

export function aiConnectionRows(result: AiConnectionTestResult | null): AiConnectionRow[] {
  if (!result) return [];
  return [
    {
      label: "连接",
      value: result.status === "ok" ? "已连接" : result.status,
    },
    {
      label: "提供商",
      value: result.provider,
    },
    {
      label: "Base URL",
      value: result.base_url,
    },
    {
      label: "模型",
      value: `${result.model} / ${result.model_found ? "已找到" : "未出现在列表"}`,
    },
    {
      label: "模型列表",
      value: `${result.models_count} 个`,
    },
    {
      label: "耗时",
      value: `${result.duration_ms} ms`,
    },
  ];
}
