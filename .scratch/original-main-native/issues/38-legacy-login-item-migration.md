# 38：既有启动项的关闭与迁移

**Status:** in-progress — R60 production recovery/RPC/UI integration, strict resource build and original-Vue synthetic-RPC browser slice are verified. Native GUI, real LaunchAgent and next-login behavior remain unverified. Do not close this issue or treat the browser fixture as OS acceptance.

仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。依赖ticket37的共享状态/事务接口，主Agent定接口与验收，Luna实施。

## R60 当前集成状态

生产启动恢复经 `recover_for_startup` 接入；login-item read/change 在共享操作锁下先执行 `recover_locked`，并持锁直到操作完成。生产路径固定为 `~/.atools/login-item-recovery`，并核验生产 app identifier/NSBundle。Main/Child 已接入严格的 read、legacy-inspect 与 resolve RPC。

原 Vue General 通过隔离 staging compatibility patch 接入，Svelte 回退页复用共享 controller。未知状态禁用普通开关，原Vue明确显示“状态未知”并隐藏会看似关闭的slider，同时保留input mixed/indeterminate语义；只有通过校验的 legacy 状态才提供“关闭旧启动项”“迁移到新机制”“暂不处理”三个明确选择。CAS、approval与legacy拒绝均清缓存，明确重试须fresh read；未改 pinned upstream、stylesheet字节或默认产品入口。

Root 实际 General 154项、Child 131项通过（1项既有ignored）；accepted资源下feature workspace check通过，保留262 warnings。最终定向前端41/41通过，之前较广Settings回归154/154通过，两者有重叠不相加；compatibility patch、严格TypeScript build和Svelte 0/0通过。正式Settings资源790459B，比基线增加6144B，恰好达到未修改的增量预算；无剩余增量空间。最终原Vue浏览器run `8f87c7b8e0d241bab707f153d046172b` 五页14/14检查通过，源码/产物稳定，自有服务已关闭。仅RPC返回为合成，不代表Rust IPC/真实OS；北京时间2026-10-29 21:13:52只读查询仍明确locked。见 [R60 verification](../../../output/renderer-legacy-login-integration-2026-10-29/verification.md)。

未读取或改动真实用户 LaunchAgent；真实 Native GUI、实际 OS 迁移、下一次登录行为及清理仍未验证。本票继续 in-progress。

## R59 结果（历史检查点）

本节记录R59结束时的私有文件与重开恢复结果；R60已补生产恢复/RPC/UI接线，但未改变OS验收边界。

已实现4KiB严格journal、真实文件LegacyPort、固定源/备份/临时记录定位、fd锁与目录身份核对及重开恢复。私有文件配合Fake ServicePort验证关闭、迁移、失败补偿、ForwardCommitted收尾、pending发布中断、还原源后中断、冲突/未知保留。Root General137项通过，其中legacy60项；workspace check及独立review通过。真实RED与旧目录guard回放证明新增回归能发现原缺陷，见[验收结果](../../../output/renderer-legacy-login-durable-2026-10-29/verification.md)。

在R59结束时，生产启动恢复、共享授权命令和显式选择仍待完成。R60现已接入这些生产路径，但仍不切默认入口，也不以私有文件测试宣称真实启动项已关闭或已迁移。

R49新backend使用macOS公开SMAppService；检测到旧产品 `com.atools.desktop.plist` 时返回明确LEGACY_CONFIGURATION并保留原文件，避免自动改写或形成双启动项。该保护并未实现旧配置的关闭/迁移；不得以“已识别旧配置”宣称恢复了这类用户的完整开关功能。

后续交付须支持用户明确操作下的安全关闭及有意迁移：核对自有Label、可执行文件与有界常规plist；保留原始字节/文件归属；不因关闭登录启动而终止当前有未保存工作的应用；失败恢复旧实际配置，未知状态明确报告。只处理本产品明确归属的启动项，不改其它应用。现代和旧配置混合状态不重复注册；API可用性/用户批准与配置损坏分开处理。

一并核对Svelte回退入口的初始状态投影：原Vue按OS状态保存后，旧General数据库布尔值不能再作为OS真值展示。写入已共用backend，不代表所有旧读取入口已验证；跨入口开关读回应进入同一真实系统状态来源。

真实验收必须使用独立临时bundle和唯一自有旧配置，先冻结所需OS路径与归属，证明关闭后不再具备下次登录启动资格、现代注册读回、失败补偿与回收。用户的真实旧启动项及数据不作为破坏性测试夹具；未完成前保持默认入口迁移限制。跨平台和旧macOS支持仍各自单列。

## R51 范围结果

本节只记录R51检查点的结果；R60生产集成状态见上方。

实际 run `689bdffde00d4dcd8ed3559de680511c`、PID33249自然exit0；原12阶段和七项必需侧报通过。QA专用入口挂载生产 `SystemPanel(panel=settings, settingsMenu=general)`，不启动完整 `App`，也不改变默认产品入口。数据库对外布尔值为false、OS真值为true时，原Vue与Svelte均按OS读回；设置切换后的跨入口fresh读取也一致。普通placeholder保存保留启动状态字段及未知marker；真实陈旧CAS冲突后，显式重读显示当前OS状态。读/改/普通保存计数为3/2/1；原始数据库SHA前后均为`9e64883075932153ee83ba7ead3ba5853dfd9b618a6c74953713e4969f931cfb`，raw `launchAtLogin`缺省值保持不变。

现代OS登录项已注销；进程自然退出，window/child/session/layout/pending归零，observer注册/移除2/2，activation/focus/key均为0。自有root和app bundle已移除。1358份Native输入SHA `7d3e0dd5dd16474bd707e298853e4d8d2911d92b19b6b05abdb6f22333cb362d`、binary SHA `a075263603c3a9cfa613d170c219c9fc7eeab059ef916af9151b4bbd77f8501f`、receipt `1793250784539`前后稳定。Main593564B、Settings788644B且原预算未变；QA fixture 716654B只由专用测试入口加载，不进入默认产品入口。Root复验定向Rust 11项、最终Node gate 20/20、workspace check及当前Native example build通过；20项为最终gate套件，不是跨批累计。严格validator对同一原始Native产物复算通过，没有重跑Native GUI。原始证据：[Native报告](../../../output/renderer-settings-input-native-2026-10-27/run-689bdffde00d4dcd8ed3559de680511c/native-report.json)、[跨入口报告](../../../output/renderer-settings-input-native-2026-10-27/run-689bdffde00d4dcd8ed3559de680511c/native-login-cross-entry-report.json)、[独立复算记录](../../../output/renderer-login-cross-entry-2026-10-29/verification.json)、[R51验证摘要](../../../output/renderer-login-cross-entry-2026-10-29/verification.md)。

6707仅记录关闭阶段的通用清理错误，不能从原产物回推具体失败分支；77444为重复判据误用marker。两份旧失败报告保持原样；夹具修复后由新run验收，没有修改旧报告或放宽门禁。在R51检查点，旧启动项关闭/迁移尚未实现；该run只证明隐藏模式下专用Settings入口和生产设置组件的跨入口状态读写，不代表完整App启动、可见像素/材质/IME、物理键盘、重新登录启动、旧macOS/其他平台或发行完成。整应用性能也未在该切片验收。迁移仍需遵守下方[迁移合约](../../../docs/contracts/ztools-legacy-login-item-migration-2026-10-29.md)，尤其不能因关闭登录启动而终止当前应用。

## R52 实现记录（历史检查点）

以下是R52阶段记录；其中“未接durable adapter/生产命令/UI选择”的状态由后续R59/R60结果更新。

R52阶段加入纯端口迁移策略与严格旧 plist 检查器；当时的结果不代表 OS 验收，也不接受候选方案或关闭本票。检查器只在私有临时目录测试，保留原始 bytes/hash/identity 并拒绝不匹配配置。实际同卷 rename 回归核对 bytes/hash 与源路径缺失；rename 比较使用 device/inode/uid/gid/mode/length/mtime，不把 ctime 纳入比较，但仍由读取阶段完整 identity 检查保护。许可范围内的 mode 改动会使 rename 比较失败。

决策层复用共享服务状态分类：`NotFound` 与 `NotRegistered` 都作为 disabled 参与决策；durable journal 另存原始状态。策略/fake-port 与私有文件测试覆盖候选分支，不证明持久文件系统恢复。Main最终General回归98项通过（含本批24项），workspace check exit0；新增未接线模块带来22条dead-code警告，明确保留。7个Native新增/变更文件全部≤500行、无删除和依赖/锁变化，见[R52前置验收](../../../output/renderer-legacy-login-2026-10-29/verification.md)。在R52检查点尚无 durable staging/journal adapter、重启恢复、显式UI选择或生产命令，也未操作真实 LaunchAgents；这些限制由R59/R60进展更新，但OS acceptance remains pending。

后续R54修复真实base配置dev.atools.desktop被只认历史com ID的守卫拒绝的问题：两项精确白名单仍核验实际NSBundle，隔离授权不变，旧plist文件/Label不改。Main feature General101项与workspace通过，配置读取回归已接，见[配置授权验收](../../../output/renderer-production-login-scope-2026-10-29/verification.md)。这仍不替代本票的真实旧项迁移或production注册验收。

## R50 范围结果（历史）

回退控件不再显示General旧bool；复用共享OS backend的专用read/change API，普通Native表单省略系统字段且服务端拒绝混写。Main独验Rust74、前端59、类型和构建通过；整页用严格mock IPC/独立fake OS验证DB/OS不一致、单次CAS不触发普通保存、重挂读回。尚无本轮新API的Native IPC/GUI证据，不据此关闭本票。见 [R50证据](../../../output/renderer-login-state-source-2026-10-29/verification.md)。旧配置的候选事务及待验边界见 [迁移合约](../../../docs/contracts/ztools-legacy-login-item-migration-2026-10-29.md)，仍未操作真实启动项。
