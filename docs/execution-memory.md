# ATools 本地执行记忆

ATools 的执行记忆用于复用已经得到用户认可的参数、工作区事实、纠正、任务配方和失败恢复经验。它不是聊天历史，也不会把模型推断自动升级为永久事实。

## 写入边界

- `explicit`：用户主动保存，可长期启用。
- `confirmed_candidate`：系统或 Agent 提议后，由用户确认保存。
- `temporary`：只在期限内有效，必须设置 `expiresAt`。
- 密码、Token、API Key、Cookie、私钥和常见凭据格式会在核心层拒绝写入。
- 凭据应由独立 Secret Vault 管理；MemoryItem 只允许保存非敏感参数或凭据引用。

用户可在 Agent 面板查看、编辑、启停、删除、导出或清空全部 MemoryItem。所有数据只存储在本地 SQLite 数据库。

## 检索与应用

第一阶段使用确定性的结构化作用域匹配，不依赖模型、网络、远程 embedding 或向量数据库。作用域越具体优先级越高，支持：

1. 工作区；
2. Skill；
3. 工具；
4. 应用或域名；
5. 全局偏好。

MemoryItem 的 `content.arguments` 会作为工具调用的缺省参数。调用方显式提供的参数永远优先，记忆不会覆盖它们。匹配到的记忆 ID 写入 TaskRun；结果中心展示记忆来源、内容和影响规则，并记录使用次数与成功次数。

MCP、Agent 工具调用和人类从搜索结果打开插件功能都会写入同一 TaskRun 存储；后者以 `plugin.feature.<featureCode>` 作为能力标识，保留成功或失败的激活结果。

成功的 TaskRun 可在结果中心由用户点击“保存为配方”，形成带 `sourceRunId` 的 `explicit` 任务配方。保存动作不会绕过敏感内容检查；如果原始输入含凭据型字段，核心层会拒绝写入并在界面提示原因。

## 示例

```json
{
  "type": "preference",
  "scope": {
    "tool": "compress_images"
  },
  "content": {
    "arguments": {
      "quality": 82,
      "format": "webp"
    }
  },
  "confidence": 1,
  "approval": "explicit"
}
```

若调用方传入 `quality: 95`，最终参数保留 `95`，只从记忆补充缺失的 `format: "webp"`。
