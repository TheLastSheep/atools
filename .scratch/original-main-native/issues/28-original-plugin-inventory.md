# 28：原版主程序插件目录首次读取与变化刷新

**What to build:** 原版主搜索首次加载时等待内置插件元数据登记完成；安装、更新、卸载、禁用/启用及动态指令变化后，原版界面自动读取当前目录，不长期使用启动时的空列表或旧列表。

**Blocked by:** None（R37 隐藏功能验收通过；可见画面缺口独立保留）。

**Status:** verified-hidden-native-slice — R38，Luna 实施、Main 独立验收；最终 run `4552318caa734ae1af4925fa98e3d7d4` 通过。Native执行startup和toggle，其它生命周期生产入口已接线但未逐项端到端验收，可见画面仍未验收。

- [x] 首次原生目录读取等待本次启动登记结束；失败、取消或超时明确失败，不用部分列表假成功，也不阻塞主线程。
- [x] 单个定向主 Webview 变化监听驱动共享目录缓存失效和原版 onPluginsChanged；不增加轮询、插件执行或产品常驻进程。
- [x] 并发读取共享一次查询；失效期间旧成功/失败不覆盖新状态；回调晚订阅、监听失败、非法事件和 dispose 均有确定行为。
- [x] 原版 Main store 的timestamp结果1→0→1、OS app始终1；原12/17/10门禁通过。启动2次list读取、每次toggle追加1次。
- [x] 定向类型、前后端测试、正式构建、源/产物绑定和隔离 Native 流程独立验收；Main+1711B，580KiB绝对上限不变，余60B。

证据与限制见 [R38验收](/Users/harris/Desktop/atools/output/renderer-plugin-inventory-2026-10-28/verification.md)。批量事件合并、其他生命周期端到端和完整生产app_setup启动没有被本轮单个toggle流程证明，后续继续验收。

当前不切换默认入口，不展开插件 UI 兼容，不改上游 Vue/CSS，不提交或推送。总体目标仍未完成。
