# R39：内置插件启动时保留用户状态

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，固定只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。保持原Vue/CSS、默认入口、SQLite与按需Node方案；本轮主程序状态正确性，不展开插件UI兼容。

## 原版语义与当前复现

固定上游的 getDisabledPlugins 读取持久禁用标识，以稳定插件名保存并映射到当前包路径，避免版本化包路径改变后丢失禁用。ATools Main适配使用plugins.enabled作为同一用户行为的事实源，并将禁用项投影为当前路径。

原builtin metadata loader创建enabled=true的新Plugin，原通用UPSERT冲突会覆盖既有enabled。Root运行真实startup loader的RED：首次登记→禁用→关闭全部DB句柄→重开同文件→版本和feature升级→再次登记，稳定失败于用户禁用状态被重置；见 `output/renderer-builtin-state-2026-10-28/native-red.log`。

## 生产接口

新增Core `Database::refresh_builtin_plugin_metadata_with_features(&Plugin, &[Feature]) -> Result<()>`，只由builtin startup登记调用。一个Immediate事务中UPSERT与static feature替换共同提交：已存在ID保留enabled和created_at；name/version/path/config/updated_at及static features按新包更新；首次插入采用输入enabled（真实loader默认true）。文档、附件及已有dynamic feature语义保留。

必须依据事务内已保存的enabled决定feature catalog校验和发布，不能依据loader入参。失败回滚metadata与feature索引，不让UI读到半次刷新；提交后按既有锁顺序发布/失效缓存。不得先get_plugin再save，不改变通用save_plugin、save_plugin_with_features的安装/更新/授权语义，不新增迁移或依赖。

## 两进程Native验收

复用现有source-bound临时app bundle和runNativeChild，不增加第二套通用controller。CLI新增固定QA journey `builtin-state-seed`、`builtin-state`；后者要求 `--resume-seed-pid` 为已观测Seed正整数PID且不同于自身。两者用原settings-input私有run ID/identifier/root约定，R38普通journey、root首次创建与所有门禁不变。

- Seed-only独立进程不建Webview：验证实际staged timestamp包，走生产loader登记，按实际稳定ID禁用，写固定document/attachment，关闭DB后写seed报告并正常退出。
- Node只有在Seed真实terminal、exit0、报告/owner绑定有效后才启动Main。Main通过严格的同runId/root/identifier/SeedPID校验、私有路径/regular/nofollow和单次claim后原子rebind owner，普通prepare继续拒绝existing root；不得凭任意PID接管目录。
- Main重新打开同一个app-data/data.db，两个进程的DB device/inode必须一致，created_at指纹必须一致。等待真实Pending list请求后调用真正生产builtin loader与共用completion/publish，不用R38的fresh-only通用save夹具替代。
- 原版Main store冷启动timestamp结果0、OS app对照1，DB仍disabled且文档/附件保留；生产toggle启用后timestamp1/app1，事件及list读取各增加1。metadata/session manager只初始化空表，不执行插件UI/preload。
- 固定报告为 `native-builtin-state-seed-report.json` / `native-builtin-state-report.json`，无可信passed位。Node从固定owner、bool/count/指纹事实推导结论；未知保持null，不能当成0/false通过。最后仅在本case实际spawn过的所有进程均terminal后清理owned root/bundle。

Seed数据预置不是用户界面点击；该证据证明独立进程退出后的持久文件被真实Tauri冷启动及原版Main消费，不外推为完整生产app_setup或所有用户重启操作已验收。

## 预算与边界

Main当前593860B，580KiB绝对上限593920B（余60B）保持；本轮不改Main JS/CSS或依赖。Settings782503B保持。无新增生产IPC或常驻进程，QA Seed/Main严格串行，任一时刻最多一个本次Native进程。全应用RSS、启动/搜索延迟、发行及跨平台另需实测。

Core针对首插、两种已存状态与相反入参、warm catalog/dynamic features、文件DB重开、文档/附件和失败回滚；Native单测沿完整loader重开；随后source-bound两进程Native及独立R38 12/17/10/inventory回归。可见画面继续单列，不能由hidden store结果替代。

## 本轮结果

已完成上述 hidden Native 切片，见 [Main 独立验收记录](/Users/harris/Desktop/atools/output/renderer-builtin-state-2026-10-28/verification.md) 与 [原始事实索引](/Users/harris/Desktop/atools/output/renderer-builtin-state-2026-10-28/verification.json)。两个真实进程先后使用同一持久 DB；冷启动后仍禁用、数据保留，真实启用后原 Vue 搜索恢复；同一最终二进制的 R38 12/17/10/inventory 回归通过。Core 345 passed / 3 ignored、Native builtin 6 passed、renderer 341 passed / 1 ignored、Node 合约 16 passed，工作区编译及最终构建 exit 0。所有 Native 进程正常退出，owned 临时资源回收；Main/Settings 资源体积无变化。

本结果不扩大为完整生产 app_setup 重启、可见画面、输入法、跨平台或发行验收。Gemini 补充仅作为参考，既有[评估](/Users/harris/Desktop/atools/docs/contracts/ztools-gemini-plugin-reference-assessment-2026-10-27.md)与本次附件 SHA 一致；本轮复核无实质增量，不新增平行实现或改变主程序优先排期。
