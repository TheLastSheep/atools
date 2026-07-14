# ATools 统一能力目录

`Capability` 是人类界面与外部 Agent 共同发现能力的稳定领域合同。当前目录聚合内置 Tool、插件 Tool、插件 Feature 与 Skill；外部 MCP 已保留来源和执行器类型，但在真正接入外部执行器前不会伪造目录项。

每个目录项固定包含：

- 稳定 `id`、名称、描述和来源；
- 输入/输出 JSON Schema 与权限 scopes；
- `humanInvocable`、`agentInvocable`，明确当前入口；
- 执行器类型、执行器 id 和可用性原因；
- 来源版本、已验证的 ATools 版本和平台。

内置/插件 Tool 沿用 MCP tool name，避免 Skill 依赖与 TaskRun capability id 再做映射；其中当前确有 UI 入口的 `compress_images`、`ocr_image`、`open_or_reveal_path`、`open_url` 同时标记为人工可调。`copy_text` 是人工专用能力：TaskRun 只保存字符数、字节数和 `contentRedacted`，不会落剪贴板正文。插件 Feature 沿用 `plugin.feature.<feature-code>`，与人工激活产生的 TaskRun 一致；Skill 使用 `skill.<skill-id>`。

桌面端 Agent 面板通过 `list_capabilities` 展示同一目录。外部 Agent 可读取 MCP resource：

```text
atools://capabilities
```

该 resource 是发现目录，不绕过执行权限：Tool 仍通过 `tools/call`；Skill 仍按 `atools://skills` 和对应 prompt 获取方法，并在每一步重新检查权限；只有人工入口的插件 Feature 不会被错误声明为 Agent 可调用。

目录合同不等于所有能力都已经双向可执行。新增执行入口时必须同步更新 invocable 标记、执行器、权限、TaskRun 接入和回归测试。
