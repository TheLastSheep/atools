# B48 Electron 图像剪贴板能力进展

状态：本地回归与独立代码 review v2 已接受；正式/native 原插件业务验收仍待完成。本批新增通过的原生原插件业务工作流为 0，majority direct-use、release 与 formal acceptance 均未通过。

## 本批范围

B48 为 Electron 页面 preload 增加 `clipboard.readImage()` 与最小 `NativeImage` 兼容面（`toPNG`、`toDataURL`、`getSize`、`isEmpty`）。图像权限使用独立 `image` grant，仍归属 `clipboard_read` permission scope；已有 text/files read grant 不会自动授权图片。用户显式重新打开插件时建立新的图片会话 token。图片不预热、不排队、不自动重放；成功结果只存在于当前 invocation，不写入 durable TaskRun 历史。

生产 adapter 的图像读取经一个并发为 1 的 bounded blocking worker。第二个同时进行的请求立即受控失败，不排队；结果等待上限为 1 秒，超时不代表能够物理中断已经开始的 OS provider 或解码任务，worker 完成前仍占用唯一 permit。请求边界为 encoded input 4 MiB、PNG 输出 512 KiB、成功 JSON envelope 700 KiB、单边 8192 像素、总像素 16 MP；解码器的 64 MiB allocation limit 是 best-effort。图像编码器、OS/provider 与解码器内部峰值内存不受响应字节上限保证。

macOS 读取 NSPasteboard 的 PNG/JPEG/TIFF 图像表示并规范化为 PNG；`dataForType` 可能在长度校验前由系统分配数据。非 macOS Tauri 后端只做源码审查，未跨平台编译或运行；其 wrapper 无法区分空图像与其它 provider 错误，因此失败返回受控错误，不伪造空结果。QuickJS async `utools` clipboard API 与 Node sidecar `require('electron')` 的 `readImage` 仍不支持。当前原始 paintbrush 清单未声明 `mainPush: true`，本批未开启或改写它；已安装数据库标志未检查。已有 opt-in 的 mainPush callback 可能在 query 关键词过滤前读取图片。

## 验证结果

Root 冻结了 1577 个显式 selected inputs，其中 19 个 owned 文件（14 修改、5 新增），owned 文件最大 336 行；这不是完整 compiler/dependency closure。Source post-verification 在该 1577 项范围内无漂移，HEAD 未变，未执行 Git add/commit/push。

- 前端定向：6 文件，77/77；前端全量：189 文件，1813/1813；Svelte check：0 errors / 0 warnings。
- Rust 定向：host runtime 24/24、permission context 4/4、loopback 15/15；workspace Cargo check exit 0，报告含 4 条已有 warning 和既有 `nom` future-incompatibility 提示。这里不代表“全量 Rust tests 通过”。
- Matcher：1200 features、20 samples，最高 0.7575 ms，25 ms 预算；该指标不覆盖图片操作或竞品比较。
- 首屏 JavaScript 为 365,829 bytes / 573,440 bytes 预算，较基线增加 316 bytes；插件面板仍不在 initial graph。
- near-cap 图片 fixture 为 524,220 bytes。Fake synchronous XHR 本地观测：浏览器侧 p95 35.7 ms、Node VM p95 52.05 ms。两者来自不同 runtime，属于单次本地观察，不是 before/after 对照，也不代表真实 HTTP、原生 provider、WebKit 端到端时延或产品 UI 性能；matcher 的 25 ms 预算不适用于此操作。

原始 `clipboard-image-paintbrush/preload.js` 保持未修改并通过生产脚本构造器、browser Buffer 与 fake 文件写入/文件选择器运行；验证了手动图片授权、重新打开、保存 PNG 字节一致。文件写入和 picker 均为内存 fake，原生 filesystem transport、系统剪贴板和原插件真实业务流程没有执行，不能称原生保存完成。

最大 512 KiB PNG 经真实 Node sidecar `fs.writeFileSync` 的 transport 尚未运行。源码预算显示 binary 上限 512 KiB、value envelope 900 KiB、单次 request 1 MiB；512 KiB PNG 的 base64 为 699,052 字符，静态估算小型 JSON-RPC envelope 可在 request cap 内。该推导和 fake-fs 保存测试都不替代真实 sidecar 文件写入验证。

## 未完成与证据

原生 OS 剪贴板读取、交互式原插件业务流程、非 macOS 运行、QuickJS/Node Electron image 路径仍未验证或实现；native/original-business acceptance 为 0。超时无法中断已运行的 provider/codec，OS 与 codec 的内部峰值内存不受上述输出预算约束。B45 既有 native startup/foreground/editor acceptance gap 与一处 formatter fidelity gap 均未改变。

最终 root 汇总为 `/private/tmp/atools-batch48-root/verification-summary-v2.json`（SHA-256 `4deb778ae15c4c5d65f7923f84fde5af6128f2689687e65d8cece81af13879d8`），取代 v1 汇总。独立 review 为 `/private/tmp/atools-batch48-independent/review-v2.md`（SHA-256 `e90112d48e1761be71cb9d9fa36ad73a5732ac10597bd12d3b63e5ca76b8b7bd`），对应机器可读清单 `/private/tmp/atools-batch48-independent/review-v2.json`（SHA-256 `9297803e28c4dc99cd2d576bb62ec8b300d40cf6b443496514c29e0f8a55d349`）。Reviewer 核实 19/19 owned 文件与 freeze 精确匹配，未发现 P1/P2 生产代码问题；reviewer 没有重跑 root 全部测试。两份最终证据绑定源 freeze、worker freeze、JS freeze、实现合同、before/post source snapshot、测试日志、Cargo check、release budget 与 near-cap CPU probes。Rust worker freeze 为 `/private/tmp/atools-batch48-image/freeze-v2.json`（SHA-256 `08eab514c3ba6b13d0e276d29b152b8e18f5113e9a2fcc33b95dc55a314f7845`）。

独立 review v2 与本地回归已接受；正式/native 验收仍待完成。本进展记录的是上述范围，不构成发布或原插件业务验收。
