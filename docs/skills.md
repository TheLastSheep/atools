# ATools Skills

ATools Skill 描述“怎样把任务做好”，原子 MCP Tool 描述“能做什么”。Skill 不执行任意代码、不授予权限，也不会绕过用户确认；每一步调用的权限仍由 `tools/call` 重新检查。

## SkillDefinition

每个本地 Skill 必须声明：

- 稳定 `id`、名称、说明、版本和触发场景；
- 依赖的 `capabilityIds`；
- 有序 `steps`，每一步只能引用已声明能力；
- `permissionScopes`；
- 已知 `failureModes` 与恢复说明或恢复能力；
- 至少一条独立 `validation` 规则；
- 至少一条 `resultSuggestions`，指导结果中心选择渲染或后续动作。

Skill 通过 Agent 面板创建、查看、编辑、启停、删除和导出，持久化在本地 SQLite。停用后不会继续通过 MCP 暴露。

## MCP 暴露

桌面 MCP Server 提供：

- `atools://skills`：所有已启用 SkillDefinition 的 JSON resource；
- `atools://skills/{skillId}`：单个 Skill resource template；
- `atools_skill_<skillId>`：把 SkillDefinition 转成任务指导的 MCP prompt，可附带当前 `task`。

Prompt 明确要求外部 Agent 只使用已声明能力、逐次调用工具、重新检查权限，并在声明的验收规则通过后才能报告成功。Skill 自身不会把多个步骤包装成一个不透明的高权限执行器。

## 示例

```json
{
  "id": "compress-for-web",
  "name": "Compress images for web",
  "description": "Create web-ready images and verify target size.",
  "version": "1.0.0",
  "triggers": ["compress images for web"],
  "capabilityIds": ["compress_images"],
  "steps": [{
    "id": "compress",
    "capabilityId": "compress_images",
    "description": "Compress selected images",
    "input": { "format": "webp" },
    "optional": false
  }],
  "permissionScopes": ["file.read", "file.write"],
  "failureModes": [{
    "code": "target_unmet",
    "description": "The byte target was not reached",
    "recovery": ["Reduce dimensions and retry"],
    "recoveryCapabilityId": "compress_images"
  }],
  "validation": [{
    "id": "target-size",
    "label": "Target size",
    "description": "Every output meets max_bytes",
    "kind": "json_path",
    "config": { "path": "$.items[*].target_met", "equals": true },
    "required": true
  }],
  "resultSuggestions": [{
    "id": "images",
    "label": "Preview compressed images",
    "kind": "artifact_renderer",
    "config": { "renderer": "image_grid" }
  }],
  "source": "local"
}
```
