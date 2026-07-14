# 发票 OCR 归档

## 何时使用

当用户要整理本地下载目录、桌面或指定文件夹中的发票、收据、报销凭证，并希望提取金额、抬头、日期后重命名或归档时使用。

## 推荐工具顺序

1. `find_local_files`：在用户确认的目录内搜索发票、invoice、receipt、pdf、png、jpg 等候选文件。
2. `ocr_image`：对图片类凭证执行本地 OCR。PDF 首版应先让用户确认是否转图片，避免隐式改写文件。
3. `rename_files`：先 `dry_run: true` 生成重命名计划，展示给用户确认。
4. `rename_files`：用户确认后用 `dry_run: false` 执行。
5. `open_or_reveal_path`：打开或定位归档目录，便于用户复核。

## 权限

需要 `file_read`、`file_write`。涉及打开 Finder 时需要 `shell`。默认必须走 UI 确认。

## 注意事项

- OCR 结果不能直接当作财务事实，金额、税号、抬头必须让用户确认。
- 不要扫描用户没有明确授权的根目录。
- 批量重命名前必须保留 dry-run 审计记录。
