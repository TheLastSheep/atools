# 图片批量压缩

## 何时使用

当用户选择或指定多张本地图片，希望压缩、缩放、生成可发布素材列表，且不希望上传到云端时使用。

## 推荐工具顺序

1. `find_local_files`：按目录和扩展名确认候选图片。
2. `compress_images`：输出到用户指定目录；首版以本地副本为准，不覆盖原图。
3. `open_or_reveal_path`：定位输出目录。
4. 需要生成说明时，由 Agent 根据返回的输出路径生成 Markdown 列表。

## 权限

需要 `file_read`、`file_write`。打开输出目录时需要 `shell`。

## 注意事项

- 不要覆盖原文件。
- 用户要求体积上限时传入 `max_bytes`；工具会在 macOS 上尝试降低 JPEG 质量，返回 `target_met`、`target_size`、`target_reason`，未达标时不要假装成功。
- WebP 输出仍未接入；如果用户明确要求 WebP，应说明当前工具先生成本地压缩副本，WebP 需要后续专用编码器。
- 大批量图片应分批执行，避免长时间无 UI 反馈。
