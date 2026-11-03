# 已安装插件图标支持进展（B54）

B54 为已安装插件清单增加受限的本地图标路径投影，并在前端使用现有 Tauri 文件 URL 转换显示可信 PNG。Rust 只投影包内 builtin/imported 插件的规范化路径；前端再次校验并用 `convertFileSrc` 生成资源 URL。无效或缺失字段回退到 monogram，旧版清单记录保持原形状。图标仅为当前页最多 30 行惰性加载，不新增逐行 IPC、网络请求或缓存。

Rust 校验限制为 256 KiB 文件、512×512 尺寸及 PNG 签名/IHDR 元数据，读取固定 33 字节头部；它不解码图片，也不验证 IDAT/IEND。损坏图像仍需要前端错误回退。其他来源及非 PNG 保持 monogram。

root 验收实现检查：定向插件清单 13 文件 / 110 项通过；前端 193 文件 / 1829 项通过；Rust 定向 12 项通过；Svelte 检查 0 错误、0 告警；workspace check 退出码 0，包含 4 条既有警告。生产初始 JS 为 365,829 字节，预算 573,440 字节。该预算只描述初始静态 JS 图，不代表整个安装包、惰性插件面板大小、RSS 或交互延迟。投影基准覆盖 180 项、每项读取 33 字节头部；5 个 warm batch 为约 6.09–6.97 ms，无可比基线，且不包含数据库、列表 IPC、前端、资源服务或图片解码。

浏览器验收没有通过。v4 在 30 行挂载后等待原始 logo 解码超时，且该报告缺少网络和 DOM 诊断。v6 实际运行中，30 行挂载并出现两个已校验的 `asset.localhost` 图片地址，但收到 0 个 CDP Fetch 事件；两张图片均 `complete=false`、`naturalWidth=0`。检查通过数为 0，清理已核验。当前原因未确定；图标显示、损坏图片回退、路径变化恢复及分页检查仍未验收，Tauri 原生资源协议也未验证。该结果不能证明产品图片处理存在缺陷或浏览器环境策略是根因。

历史回归记录：前端 v1 定向检查为 3 项失败 / 107 项通过，原因是把缺失的可选字段写成 `null` 改变了旧记录形状；最终实现仅在输入对象确实含该字段时才归一化，root v2 定向检查通过 110 项。Rust v1 静态审查发现 FIFO 打开可能阻塞；v2 在读取前检查元数据，并在 Unix 使用非阻塞且禁止跟随末级符号链接的打开方式，12 项 Rust 定向检查通过。独立 Rust 审查保留一个条件性的 P2 建议：父目录组件在规范路径检查与打开之间若被并发替换，仍有路径竞态窗口；没有证明该竞态可被利用，且非 Unix 平台的竞态语义没有专项验证。

本批实现检查获接受，插件图标真实浏览器显示与原生资源传输仍待验证。多数插件直接可用、发布和正式验收均未通过；新增原插件业务工作流验收数为 0。HEAD 为 `c34789c0e3d19b3bf7c05d396540d891ff126abc`，未执行 Git 提交或推送。

证据索引：[root 验收](../../../output/plugin-input-2026-10-19/batch54-evidence-v1/metadata/root-acceptance-v1.json)、[最终源清单](../../../output/plugin-input-2026-10-19/batch54-evidence-v1/metadata/source-freeze-v2.json)、[最终浏览器失败报告](../../../output/plugin-input-2026-10-19/batch54-evidence-v1/browser/run-3f0d1b9e-656a-464e-960c-037f708ef888/report.json)、[证据 manifest](../../../output/plugin-input-2026-10-19/batch54-evidence-manifest-v1.json)、[交付索引](../../../output/plugin-input-2026-10-19/batch54-delivery-v1.json)。前序交付固定引用：[B46 v2](../../../output/plugin-input-2026-10-19/batch46-delivery-v2.json)、[B47 v2](../../../output/plugin-input-2026-10-19/batch47-delivery-v2.json)、[B48 v2](../../../output/plugin-input-2026-10-19/batch48-delivery-v2.json)、[B49](../../../output/plugin-input-2026-10-19/batch49-delivery-v1.json)、[B50](../../../output/plugin-input-2026-10-19/batch50-delivery-v1.json)、[B51](../../../output/plugin-input-2026-10-19/batch51-delivery-v1.json)、[B52](../../../output/plugin-input-2026-10-19/batch52-delivery-v1.json)。
