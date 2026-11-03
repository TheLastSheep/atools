# 29：内置插件禁用状态在启动后保留

**What to build:** 用户禁用内置插件后，下次启动仍保持禁用；启动扫描只更新插件包元数据，不重置用户选择。原版主程序的插件可用性和搜索结果应继续反映该状态。

**Blocked by:** None（R38 来源绑定批次已完成；R38其它生命周期/可见画面缺口独立保留）。

**Status:** verified-hidden-native-slice — R39，Luna 完成 Core 原子刷新与 Native 接入；Main 独立审查、运行测试及真实两进程冷启动，禁用状态和原数据保持。完整生产 app_setup 重启、可见画面与发行仍单列未验。

已复现的旧行为：包加载器生成稳定 ID 时默认 enabled=true；原 builtin 启动登记使用通用 upsert，其冲突更新覆盖 enabled，因此会把已有 false 改回 true。现已改用仅刷新 builtin 元数据的事务接口，保留已存 enabled 与 created_at。Main inventory 消费同一 enabled 持久化字段；命令级禁用是另一套设置，不能替代插件级状态。

- [x] 建立确定性 RED：真实 loader 初次登记→将同一数据库记录设为禁用→重新启动登记→原禁用状态应保持。
- [x] 已有用户状态与新包元数据正确合并；新安装默认启用，已启用项不误禁用，原数据/附件/创建时间不丢失。
- [x] 不改变通用安装/更新/授权语义，不将此行为全局塞入所有 DB upsert。
- [x] Main inventory 及原版 store 的实际搜索消费保持一致，重开/重启证据与简单内存状态区分。
- [x] Luna 实施、Main 独立审查/测试/来源绑定验收；默认入口、上游 Vue/CSS、绝对资源预算保持。

本票不展开社区插件兼容、安装市场或可见画面验收；未提交或推送。

冻结契约见 [R39](/Users/harris/Desktop/atools/docs/contracts/ztools-original-builtin-state-2026-10-28.md)。RED日志保留在 `output/renderer-builtin-state-2026-10-28/native-red.log`，失败精确为“startup metadata refresh must preserve the user's disabled state”，不以编译或夹具错误代替业务复现。

结果见 [独立验收记录](/Users/harris/Desktop/atools/output/renderer-builtin-state-2026-10-28/verification.md)。Core 345 passed / 3 ignored，Native builtin 6 passed，renderer 341 passed / 1 ignored，Node 合约 16 passed；工作区编译通过。冷启动 run `5ab998ee38d24a07b834bf404ae5c249` 的 Seed PID 52681 正常退出后，Main PID 52684 打开相同 DB，禁用及文档/附件/创建时间均保留，真实启用后搜索恢复。同一二进制下 R38 的 12/17/10/inventory 回归通过；进程及 owned 临时目录均回收。Main 593860B、Settings 782503B 无变化。
