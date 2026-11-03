# 16: 原版设置中的应用指令别名

**What to build:** 在原设置的全部指令菜单进入别名草稿，创建/编辑/删除应用别名并保存；返回主窗立即按别名搜索，重开保留。

**Blocked by:** 03/05 已有原版同窗设置承载；15 接线收敛后避免并写适配器。实施前需冻结独立CAS与全应用目录的有界读取/图标授权/资源分配，不直接复用任意set_setting。

**Status:** verified-hidden-native-slice — R41 原版界面增改删→独立SQLite读回→原Main搜索→fresh Child重开已通过真实Tauri验收；可见画面、物理输入及完整设置仍另验。见 output/renderer-command-aliases-native-2026-10-29/verification.md；R26历史证据保留。

- [x] 使用原AllCommandsSetting→ShortcutsSetting alias tab，不用Svelte替代；保留commandId→{alias,icon}[]和旧string[]归一化语义。
- [x] child session内窄getCommands/read aliases/update aliases，main-only变更通知；读取/写入/目录均有界，未知或非本期插件桶不丢失。
- [x] 独立SQLite CAS及写入结果未知/关闭保护，成功后才通知；失效两层缓存后再回调，不重扫应用目录。
- [x] 原DOM增改删→持久化→main搜索刷新→重开读回；失败/并发冲突/越限和角色拒绝保留Core/Native定向回归证据，不外推为所有GUI I/O故障均验收。

当前pinned源码：AllCommandsSetting菜单发draftTarget；ShortcutsSetting调用dbGet(command-aliases)、internal.getCommands、internal.updateCommandAliases；main.onCommandAliasesChanged重新建别名集合。原setting属于主程序，Harris/社区插件仍后置。现有Svelte localStorage的CommandAliasEntry[]是另一模型，不能只换键当成迁移。

## R40后续实施入口

R30的真实同窗输入/路由/关闭重开、R35指令禁用、R37本地应用设置及R38/R39目录与持久状态已分别完成hidden Native切片，原R26的前置缺口不应继续当作全部未接线。R40优先修复已复现的目录刷新乱序，完成后回到本票。

Luna已只读确认最短Native路径：复用现有settings_input_journey的私有child/session、probe白名单、source binding和owned cleanup；只读系统应用目录选择真实目标，别名修改仅写本次私有SQLite，不操作或启动目标应用。固定probe通过原AllCommands菜单进入Shortcuts的原别名对话框，使用原控件新增→改名→关闭/重开读回→原删除/确认；每步独立核对SQLite和原Main唯一别名搜索结果、通知及应用目录读取次数。不得直接调用mutation或child API来代替DOM保存动作。

追加固定owner/run绑定的窄报告，复用现有Node Native case/终态与清理，不另造通用controller、不削弱既有12/17/10/inventory门禁。R41运行1abb931d39ef466fbd9affd779bf8558已验收：搜索计数1/0/1/0，别名通知0→1→2→3，应用目录读取1→1，未打开插件UI或启动preload，终态exit0且owned cleanup通过。DOM setter/InputEvent不等于物理键鼠或输入法验收。Main593891B、Settings782503B的产物哈希未变；Main593920B绝对上限仍保持。
