# 42：推荐结果置顶与顺序重开后保持

**What to build:** 原Main推荐结果能置顶、排到最前或取消置顶，重开保持顺序；保存失败有原版回滚，其他固定/历史不被改写。

**Blocked by:** None；原推荐读取与上下文菜单已有，插件执行后置。

**Status:** in-progress — R64实现与分层验收完成，真实Native系统菜单/可见流程仍开放。证据：`output/renderer-recommendation-pins-2026-10-29/verification.md`。

- [x] 真实SQLite按原身份/顺序保存并重开，raw CAS/非法值/超限失败不覆盖其他记录，数字token/长扩展键/重复行保留。
- [x] 仅Main专用命令接受固定域写入，一次成功保存一次IPC，回执后才更新缓存；身份helper与原页面合成transport分别验证。
- [x] 原版消费者完成固定/移动/取消与失败回滚，未知数据不被静默清理；存量metadata不经JS往返写回。
- [x] 类型、相关回归、构建与预算实测；4KiB失败及5KiB修订明确记录。
- [ ] 真实Native系统菜单与Main IPC→SQLite完整可见流程；物理输入/IME与跨平台验收。
