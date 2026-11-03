# 10: 原版插件主页面与子窗口广播同步

**What to build:** Harris原版贴图页的变换和关闭消息可以抵达同一插件实例的主页面，页面继续使用原有BroadcastChannel接口；跨插件、旧文档及已关闭频道不接收消息。

**Blocked by:** None for source implementation and deterministic contracts. 真实跨WebView通信仍依赖暂缓的原生验收。

**Status:** source-contract verified; native/full business pending (in-progress)

- [x] main、hosted及native child走同一插件实例内的广播适配，不改变opaque sandbox，不增加Node或Rust特权入口。
- [x] 原版Harris Snipaste 2.0.1固定页面的transform与close消息经生产编译桥和认证来源路由抵达受控main接收文档（不含原React UI）；相同名的频道实例分别收到独立拷贝，发送实例不收到自身消息。
- [x] 保留structured-clone数据，不退化为JSON-only；错误、关闭、document切换、重复实例和异步消息顺序有区分性检查。
- [x] 明确消息、频道和排队上限；接收ack或失效文档释放预算，阻塞接收方不能让宿主无限排队；无周期轮询。
- [x] 主Agent独立执行相关回归、类型、构建和静态体积检查；真实WebKit跨窗口、完整业务与整应用资源保持待验。

## 行为依据与边界

固定的外部2.0.1原包中，贴图页同步按query ID读文件队列作为bootstrap，实时状态使用snipaste-pro-bus；localStorage仅为bootstrap fallback。没有接收handler的child仍会发送transform/solo/close，主页面按id更新card。宿主不能把现有16KiB JSON-only Electron IPC通道当作通用BroadcastChannel。

本批复用可信壳的原始MessageEvent与Window.postMessage路径，并维持source/document身份校验。同步原包双SOLO消息暴露的重复toggle属于原包行为，不在宿主去重或改写。初始payload的真实sidecar读取也不由广播适配替代。

本地模块分工与精确接口由主Agent派单维护；本卡只按端到端行为验收，不将源码合同升级为真实OS结果。

主Agent最终独立通过34套/261项回归、类型0错0警告、生产构建、同步脚本及离线workspace check；启动JS432,238/573,440字节，按需插件JS748,433字节（+18,772）。原包9个固定文件及前批几何15文件未变。详见 [本批记录](../../../output/plugin-broadcast-channel/verification.md)。
