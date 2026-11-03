# NativeImage 内部字节转换优化与验收（B64）

B64 已通过根代理验收。生产修改由 Luna 实现和接入，另一名 Luna 独立静态复核；根代理运行完整前端、类型、构建和隔离原生对照。目标仍在推进，本批不代表大部分插件或整体 UI 已验收。

## 生产行为

NativeImage 转换结果原先通过远端 `window.Buffer.from` 做本地 base64 转字节，每次会额外产生两次属性读取和一次函数调用。现在只在图片转换内部使用当前 Node session 的 codec 所创建的本地 Buffer；插件自己的 `window.Buffer` 仍为远端 Node Buffer。

本地字节与该 session 的 Node 编码器共享类型身份，因此传给 Node `crypto.update()` 等消费者时仍编码为 `kind: buffer`。未放宽 typed-array 名单、权限、会话校验或图片与传输预算。没有改动原始插件。

被否决的 v1 使用独立 BrowserBuffer 工厂，其字节会被编码为不受支持的 `ByteBuffer` typed array。v2 的回归测试保留这一失败反例，并让原 IdeaDock 复制函数的图片字节通过生产序列化桥、真实 CJS decoder 和 Node 哈希计算。原 IdeaDock 和 Device Link 的图片调用数组仍分别为 5 次和 4 次。

## 原生固定样本对照

同一原始 PasteboardPro `ja` 缩略图类、同一 512×512 本地 PNG、64 个不同 revision。输出均可解码为 480×480 JPEG，缓存复用不重放，第 65 个新 handle 按原限制拒绝。

| 任务类型 | B62 基线 | B64 |
| --- | ---: | ---: |
| 属性读取 get | 195 | 67 |
| 函数调用 call | 129 | 65 |
| 模块加载 require | 3 | 3 |
| 图片转换 nativeImageTransform | 129 | 129 |
| 非请求任务 | 1 | 1 |
| 全部任务 | 457 | 265 |

减少 192 次内部任务。两次查询均完整、低于 1000 行上限且全部终态，图片操作保持 128 次成功、1 次预期容量拒绝。授权范围一致，CSP、opaque frame、隐藏且不聚焦、图片引擎归零、Node/宿主剪贴板会话归零、transport 停止、自有进程退出和临时目录清理均通过；Pasteboard backend 调用为 0，capture 未启动。

单次 debug 观察中，首条耗时 391→262 ms，后 63 条 P50 354→290 ms、P95 425→298 ms，总 await 23339→18610 ms。这不是受控发布版性能结论：200 ms 资源采样会影响耗时，启动与 JPEG 解码不在该 await 内，也没有把总耗时分摊到各方法。

原生输出比较证明可解码、尺寸和字节长度一致，未留存逐张 JPEG payload 来证明精确字节相等。独立 PNG 消费者测试检查实际 payload 字节。

## 检查与性能预算

- 定向前端：12 个文件、154 项通过；全量：200 个文件、1868 项通过。
- Svelte/TypeScript：0 错误、0 警告；普通 workspace 与原生 feature/example 编译通过。
- 生产初始 JavaScript 依赖图：367118 / 573440 字节，与 B61 相同。独立懒加载依赖为 252071 字节，命名 panel chunk 为 246614 字节，均不在初始静态图中。这不是整个懒加载依赖图总量。
- 1636 个选定源在原生运行前后无漂移；该清单不是编译器完整依赖闭包。每次运行中的可执行文件哈希一致，跨版本二进制分别记录。
- 图片 512 KiB、通用传输 1 MiB、本地 BrowserBuffer 16 MiB 与 64-handle 限制均未扩展。

资源采样仅覆盖自有 root 进程组；Node、WKWebContent 和 XPC 没有独立身份绑定，不能作为整应用 RSS 或物理内存结论。现有 Node 工具仍有包括 Network 在内的 10 个 scope，本批没有全局网络隔离证明。缺 helper 的旧桥 fallback 保留原代码行为，未增加专门回退测试。

## 证据与后续

验收记录：[batch64-root-local-image-bytes-acceptance-v1.json](../../../output/plugin-input-2026-10-19/batch64-root-local-image-bytes-acceptance-v1.json)。归档包含 73 个 payload，3373867 字节，保存被否决的 v1、v2 源码、真实 before、测试日志、原生 IIFE/页面/原类/图片、B62 对照和生产依赖图；逐项哈希、字节及原始内容校验通过。

发布版构建 profile 与独立 Node 启动测量 B63 随后已通过有界运行验收，见[发布版观测记录](2026-10-19-release-image-startup-observation.md)；ImageToolbox 的完整原入口验收 B65 仍在私有候选阶段。图片读取 hook 属于 ImageToolbox 自己的 preload，不是缺失的宿主公共 API，本轮未新增此类 API。实际点击、键盘、视觉体验、安装全流程和大部分插件可用性仍需分别验收。未创建 Git 提交或推送。
