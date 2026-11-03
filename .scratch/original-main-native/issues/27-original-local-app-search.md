# 27：原版通用设置的本地应用搜索开关

**Status:** verified-hidden-native-slice — R37，Luna 实施，Root 审查及独立验收通过；真实 Native run `8740a28a4b604aa3a3731d3d031caa93` 的 17 项事实全部通过。可见画面与完整 UI 对齐仍未验收。

**Blocked by:** None（R36来源绑定回归已结束，可见画面缺口独立保留，不阻止此功能）。

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。上游固定commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`，保持原Vue/CSS；主程序优先，插件不在本票范围。

## 真实调用链与实施前缺口

原版 GeneralSetting 的“本地应用搜索”复选框先保存 `settings-general.localAppSearch`，再调用 `internal.updateLocalAppSearch(boolean)`。上游 Commands API 更新开关并通知 `apps-changed`；关闭时 `getApps()` 返回空数组，原 commandDataStore 重载并重建索引。插件和本地启动项通过其它集合加载，不受此开关影响。

ATools Child投影可读取该字段，但 editable白名单与Core General写入字段均未开放；Child facade也缺该更新方法。固定原版Main的 `hostAdapter.getApps` 当前直接返回完整应用目录，General事件schema未包含该字段，尚未接通原Main消费者。Svelte的includeApps逻辑不能作为原Vue Main通过证据。设置页 `renderer_commands_catalog::capture` 也不是主搜索数据路径。

## 完整交付边界

- [x] Core布尔字段验证、既有CAS/格式/大小/未知字段与关闭会话保护继续适用。
- [x] Child保存与原更新通知接通，不额外重复提交或授予通用写入能力。
- [x] 原版Main在启动读取开关，并在General事件后刷新原commandDataStore索引；只移除/恢复direct/app搜索项，其它集合由原路径保留；真实 timestamp 对照始终保留。
- [x] Native `list_launcher_apps` 保持完整；Main resolve 由模块测试覆盖，Native 流程核对目录和规范化路径成员，不声称运行时额外调用 resolve。
- [x] 原版设置关闭/开启→SQLite→Main实际搜索结果、关闭重开持久化通过；目标计数1→0→1，对照始终1。
- [x] Luna实施、Root独立检查关键diff/类型/定向测试/正式构建/真实Native流程，资源预算调整显式记录，退出资源归零。

关键源码：上游 `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`、`src/main/api/renderer/commands.ts`、`src/main/api/plugin/internal.ts`、`src/renderer/src/stores/commandDataStore.ts`；ATools `packages/ztools-settings/src/childBridgeProtocol.ts`、`childBridgeGeneral.ts`、Core `db/renderer_general_settings.rs`、Main `hostAdapter.ts`、`generalPreferenceSchema.ts` 与 `generalPreferenceEvents.ts`。

具体实施前由Root冻结Main的原 `apps-changed` 适配接口与有界缓存失效，避免重造UI store或改写原Vue；涉及已有492行hostAdapter时先做职责归属检查。不得切默认入口或暂存/提交/推送。

R37冻结契约见 [localAppSearch契约](/Users/harris/Desktop/atools/docs/contracts/ztools-original-local-app-search-2026-10-28.md)。原13个editable字段顺序保持，末尾追加localAppSearch；不新增Nativeoperation或重复写通知。为验证关闭/重开持久化，fixture允许多一个顺序fresh Child，同时仍最多1个Child和既有2个observer，不增加进程。验收不足不标为通过。

最终检查：Core 11、前端270、Native336（1 ignored）、Node91通过，类型/正式构建/workspace check exit0。Main比R36增加1949B，Settings增加162B；预算、失败历史、来源及限制见 [R37验收](/Users/harris/Desktop/atools/output/renderer-local-app-search-2026-10-28/verification.md)。
