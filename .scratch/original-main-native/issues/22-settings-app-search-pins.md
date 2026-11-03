# 22: 原设置页固定应用到搜索

**What to build:** 用户在原版所有指令页的系统应用菜单选择“固定到搜索”或“取消固定”后，主程序使用同一持久记录和通知更新；返回搜索及重新进入设置均显示实际已提交状态。

**Blocked by:** 19 的真实同窗输入/退出承载已具备；复用已有 app-state 事务与 Main 通知。在同批原生来源冻结/验收期间不修改 renderer 或 Native 输入闭包。

**Status:** verified for direct/app hidden-native slice — R32 schema3真实十二阶段、独立校验、实际exit0/owned回收通过，原菜单固定/取消→SQLite修订0→1→2→Child读回→原Main固定组变化全部有证据。Source/预算/default+legacy编译通过，详见 `output/renderer-settings-search-pins-2026-10-27/verification.md/json`；不是可见像素、插件固定或完整主程序验收。

- [x] 原版 pinApp(命令对象)、unpinApp(path, undefined, name) 参数按真实 direct/app 身份映射；未知插件/feature 仍明确拒绝，不开放任意设置键或 RecordLaunch。
- [x] 复用当前 Core namespaced app-state 即时事务和 revision，保持历史、其他固定项与未知元数据；支持重复 pin/unpin 的既有语义。
- [x] Child 关闭后尚未取得 Core 写事务的请求拒绝；文件DB排队guard测试、Native会话检查和退出会计分别验证，已通过guard的owned事务继续完成。
- [x] 提交后复用现有 Main app-state 通知，原页面重读不被不可变 commandSettings 缓存挡住；不增加系统应用扫描或常驻 Node。
- [x] 失败保持失败并保留可重试状态；参数/角色/guard/重开及unknown归一化分别验证，真实磁盘提交故障注入仍未执行。
- [x] 原版 DOM 菜单→真实 Rust/SQLite→原 Main 与设置重读的完整链有证据；类型、来源、预算、回收通过。

禁用/启用指令写入及其缓存/过滤链另行推进；当前只读状态不当成写入能力。当前原 Vue/CSS 和默认入口保留，主程序优先、Harris 插件后置。
