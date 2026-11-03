# B58：库存图标的原生资源协议验收

本批补齐 B54 库存图标的一个验收缺口：固定原插件 PNG 通过生产 `list_plugins` 投影、`PluginInventoryPanel` / `PluginInventoryIcon`、`convertFileSrc` 和 macOS Tauri 资源协议，在真实隐藏 WKWebView 中完成解码。

结果为 `one_native_inventory_png_decode_accepted`。这不是原插件业务流程、可见绘制、竞品 UI 对齐、大多数插件可用或性能预算的验收。

## 实现范围

Luna worker 实现，主 agent 独立检查、编译并运行。仅涉及五个源码路径：

| 路径 | 归属 |
| --- | --- |
| `src-tauri/src/legacy_runtime/desktop_smoke_inventory_logo.rs` | 新增独立原生库存验收入口 |
| `tests/components/nativePluginInventoryLogoSmoke.ts` | 新增生产库存组件解码探针 |
| `src-tauri/src/legacy_runtime/desktop_smoke.rs` | 特性开关内的早期分发 |
| `scripts/probe-plugin-panel-native.mjs` | 新增显式 inventory-logo 场景 |
| `scripts/lib/native-panel-source-binding.mjs` | 纳入相关源文件绑定 |

验收入口不运行正常应用入口。它使用私有 SQLite、临时插件目录和独立环境，保留明确的 CSP、资源访问范围和报告令牌。没有安装或执行原插件 preload，没有窗口显示、聚焦、桌面输入或系统剪贴板操作。

## 独立检查

| 检查 | 结果 |
| --- | --- |
| 库存图标定向测试 | 4/4 通过 |
| Svelte / TypeScript 检查 | 0 errors，0 warnings |
| 原生 smoke 特性编译 | 通过 |
| 全 workspace 编译检查 | 通过；4 个既有 warning，另有 nom 的未来兼容提示 |
| 原生 fixture 参数隔离检查 | 通过 |
| 真实 macOS arm64 Tauri / WKWebView | 通过 |

原生检查首次遇到 CSP 枚举构造错误，第二次遇到命令处理器类型推断错误。Luna 在同一新 Rust 文件中作了两处窄修复；失败日志和精确前后版本均已保留。最终源代码完成重新编译和实际运行。

固定源为 `calculation-paper/logo.png`，5031 bytes，SHA-256 `390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353`。其结果如下：

- 生产库存 IPC 恰好一次，导入记录和规范化图标路径正确。
- 图片 `decode()` 成功、`complete=true`、自然尺寸 200×200，未显示 monogram 回退。
- CSP 内容匹配，报告的 CSP violation 为零。
- 实测窗口 `visible=false`、`focused=false`，剪贴板 backend 调用为零，捕获任务未启动。
- 测试进程正常退出；主 agent 再次检查固定 PID / PGID 无剩余进程，临时应用数据和环境目录均不存在。
- 运行前后 1607 个选定源文件无漂移；该集合不是编译依赖闭包。

## 证据与边界

证据目录为 `output/plugin-input-2026-10-19/batch58-evidence-v1/`。`manifest.json` 记录 42 个 payload，共 1,112,777 bytes，SHA-256 `c785a42ac9321fe6e62fa039680f17520df5ceab52aa4999f8718fd1b6002e4d`。它包含原生报告、主 agent 运行记录与退出复核、检查日志、最终五文件、实际三个原始文件及修复历史。

生成的 IIFE 与原生可执行文件只在运行记录中保留尺寸和摘要，归档不包含其完整字节；临时构建目录已删除。隐藏窗口的解码成功不能证明可见画面或交互体验一致。没有采样全应用内存、CPU 或图片延迟，因此本批不作性能达标声明。

B57 的完整浏览器激活返回流程仍待验收。本批没有补足该流程，也没有改变其既有证据状态。未执行 git add、commit 或 push，HEAD 保持 `c34789c0e3d19b3bf7c05d396540d891ff126abc`。

下一批已派发给三位 Luna worker：通用 NativeImage 引擎、专用受限源图读取通道、前端适配。起始设计预算为每会话 64 个句柄 / 32 MiB 压缩源、全局 64 MiB 压缩源、每源 4 MiB，读取前预留容量，解码任务全局单个且不排队。这些是待实现和验证的边界，不是已验证的性能结果。
