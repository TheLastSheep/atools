# 41：原版自动带入复制内容可保存并即时生效

**What to build:** 原 General 修改自动带入时限后保存，原 Main 即时采用该策略；关闭时不自动读取，开启时仅带入时限内的当前复制内容，手动粘贴继续工作。

**Blocked by:** 40 当前剪贴板读取已具备；可见/物理焦点验收单独保留，不阻止本票生产接线。

**Status:** in-progress / verified-scoped-layers — R63已修Core、Settings写入、Main通知与启动竞态；真实Native GUI整条运行、可见/跨平台仍开放。见 `output/renderer-auto-paste-2026-10-29/verification.md`。

- [x] Core五个原版选项经共享CAS存入真实SQLite并重开；非法值和冲突不覆盖既有配置。
- [x] 原Settings bridge保存/确认测试仅发一次配置patch，错误/过期会话拒绝；模拟RPC不记为真实Native提交。
- [x] 原Main浏览器消费者验证off/时限/过期/手动paste与启动早到关闭通知RED→GREEN。
- [x] 相关类型、回归、正式构建及原资源预算通过，原版模板/样式及默认入口不变。
- [ ] 原General控件→Native提交→Main真实focus的一次完整运行，general剪贴板、可见/物理输入及跨平台仍待验。
