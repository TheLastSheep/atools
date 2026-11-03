# R37：原版本地应用搜索开关

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，上游固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。North Star/ADR-0002保持：原Vue/CSS、Rust核心、Tauri与按需Node，默认Svelte入口保留；本轮主程序功能，不展开插件兼容或同步。

## 用户行为与写入

原GeneralSetting复选框保存完整settings-general投影后调用internal.updateLocalAppSearch(boolean)。沿用有界General串行CAS、session/bundle/revision guard与同一次提交的通知回执；update方法确认同值已保存且通知成功，不重复写入或增加IPC。Core与Child原13个editable字段顺序保持，末尾追加localAppSearch成为14项。仅布尔可写，null/数字/字符串/数组/对象拒绝；其它只读字段和所有现有大小/队列上限保持。

原生事件仍为atools://renderer-general-settings的version1/raw完整JSON，不新造operation或扩大通用权限。存储未知字段和其它偏好保留，CAS冲突、会话关闭及通知未确认不得假成功。

## 原Main消费

仅针对固定原Vue Main：冷启动读取settings-general.localAppSearch，缺省true；已存在非法值不能隐式当成true/false。先建立共享General事件监听再读，旧在途读成功/失败不得覆盖新事件值。注册失败需明确不可确认，不缓存成稳定可用。

getApps作为搜索入口，false返回空应用集合；原Native list_launcher_apps和目标resolve保留完整。切换时先更新搜索偏好，再触发原onAppsChanged回调，让未改的commandDataStore重载并重建索引。插件、内置及local-shortcut集合由其既有路径保留。相同值事件不反复重扫应用，不新增第二个同名Native监听；目录更新与偏好切换、callback错误隔离和dispose各自保持。

不以Svelte includeApps既有逻辑或设置页readCommands快照代替原Main搜索消费，也不向原store插入临时假command。

## 实际验收

原General checkbox关闭→实际SQLite保存false→原Main store真实搜索排除direct/app→关闭并重新打开设置Child仍为false→原checkbox开启→数据库true且Main无需重启恢复。验证原生目录与启动解析保持完整，并用实际非app控制结果证明其不受影响；无真实控制条目或任何unknown都不能算成功。

保持旧12阶段、禁用启用、材质/主题、源/产物/binary/receipt绑定和退出回收。为关闭/重开验证，允许多一个顺序fresh Child，同时最多1个Child、既有2个observer，不增加进程。新增报告单独记录owner、固定checks和固定错误，不直接改DB绕过原UI恢复。

本轮只hidden functional，不重复R36已失败的可见参数试验；没有物理输入或合格画面不能宣称完整UI对齐。初始资源门禁沿用R35：Main有效590782字节，Settings有效783560字节，实际构建测量后记录；不得由manifest任意改值或为过门禁删校验。未暂存、提交、推送或切换默认入口。

## R37明确预算调整

首次Main正式构建被R35门槛拒绝，实测592172字节（+1972）。在保留正确行为后，Root明确冻结新milestone `original-vue-local-app-search-2026-10-28`：Main baseline590200、增量3072、绝对593920、有效593272；旧两种精确策略保留，不允许任意manifest自报。最终Main592149（+1949），Settings782503（相对上一批+162）；Settings策略不变。详见 [预算决策](/Users/harris/Desktop/atools/output/renderer-local-app-search-2026-10-28/budget-decision.md)。该调整覆盖上文初始Main门槛，不改写历史失败或当作性能改善；完整运行性能验收继续单列。

## 实际验收结果

run `8740a28a4b604aa3a3731d3d031caa93` 的17项事实全部通过，真实Main搜索的目标应用计数1→0→1，真实timestamp控制始终1；关闭/重开false持久化和原UI恢复true均通过。旧12阶段、禁用/启用10项、来源绑定和资源回收均通过，Native正常exit0。General本身隐藏主输入框，因此本轮用真实store查询，不将不存在的输入框记为输入验收通过；旧流程输入门禁保持。可见画面仍unverified。详见 [完整证据与限制](/Users/harris/Desktop/atools/output/renderer-local-app-search-2026-10-28/verification.md)。
