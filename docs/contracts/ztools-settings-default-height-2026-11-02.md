# R75 原版默认内容高度与内置设置承载

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；上游固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。保持主程序优先，使用 owned Settings Child 作为真实消费者，不扩第三方插件运行或切换默认 Svelte 入口。

## 固定上游语义

`settings-general.windowDefaultHeight` 是插件**逻辑内容高度**，不是搜索窗口总高。原头部为58；manager未配置时默认542，因此首次请求总高600。原General控件默认/重置541，显式存541后请求总高599；不能拿UI投影541替代raw缺失判定，也不能添加不存在的59px头部。搜索态的DOM scrollHeight+1属于另一条布局链。

原handler先保存General，再await `setWindowDefaultHeight`；setter只改变后续默认，不即时resize当前插件，也不清缓存。普通重开优先缓存高度，缺缓存才使用默认；重启/缓存失效后才保证采用新默认。上游缓存的是requested内容高：父窗按工作区裁剪后，Child仍使用requested高度，不能将被动裁剪后的actual高度写回缓存。

## 保存与确认

- Core沿既有General无损合并/CAS接入有限number且至少200，支持合法小数及2001，不套用Svelte的1200上限。相关投影、回读和消费者都须保留小数。非finite/错误类型拒绝，物理像素换算沿现有i32范围检查，不溢出或静默截断。
- 保留原save→await setter顺序，不改原模板/CSS。保存失败继续抛错，setter不得执行；setter自身失败必须reject并沿既有错误反馈恢复已确认状态，旧失败不覆盖较新输入/会话。
- 复用General队列、revision/token和现有patch操作，不增加第二种RPC或持久存储。成功提交含height的patch后记录session/revision/value收据，随后setter匹配当前确认值可本地确认，普通改值只有一次patch通信。
- 缺字段但投影为541时，显式重置不得空确认。若无匹配提交收据，setter通过同一CAS强制单字段patch `{windowDefaultHeight:541}`；当前确认值已改变或session失效时拒绝旧setter。读取投影不能冒充字段已经持久化。
- Svelte保持现有显示/尺寸限制，但无关保存不得把显示归一化后的1200写回覆盖原版的2001/2001.5。沿现有Native writer的unchanged-field过滤省略未变化height，显式变化仍提交；复用expected快照与Native合并保留当前DB值，不在前端读旧raw再整条回写，不增加RPC或改Svelte模板。

## Native承载与缓存

只给owned Settings使用专属内容高度策略。已有MainChild消费者继续FillParent，Svelte及旧`reset_window`签名/语义不改。Settings fresh open在创建Child前选择同bundle运行期缓存或raw默认，父窗按requested+58经过既有frame/workarea限制；Child创建和lease后续布局保留requested逻辑高，按DPI计算物理高。父级裁剪与Child requested bounds分别记录，不能把返回成功当作已验证像素裁剪。

Settings当前没有`setExpendHeight`/`resizeWindow`调用入口，本批不新增这些API。缓存只保存已Ready成功会话的desired内容高及必要身份，正常关闭后保留，fresh runtime失效；bundle变化不可复用旧bundle缓存。失败打开/旧代完成不能覆盖已确认缓存。已有session重复open仅focus，不重新套默认值。被动Resize/ScaleFactorChanged只重排同一desired，不反向更新默认或缓存。

关闭返回仍由原Main按搜索内容计算高度，不额外恢复600，不show/raise。布局注册、关闭、迟到事件和缓存提交须以当前session/registration/bundle身份核对；不跨Native调用持有session/注册锁。复用现有事件源，无新增轮询、常驻进程或逐键IPC。

## 验证与预算

1. Core与投影：缺失/显式541、200/200.5/2001、非法数值、无损字段保留、CAS冲突和失败不写入。
2. 原General DOM：blur/Enter、重置、changed-case一次patch、缺失→541补提交、保存失败跳过setter、setter拒绝及旧调用/新会话保护，模板/CSS保持。浏览器合成事件不当系统输入证明。
3. Native：无缓存首次、同bundle缓存优先、保存/reset不即时resize/清缓存、bundle改变/fresh runtime读新默认、失败打开/旧代不污染；parent裁剪与Child requested保持、小屏/DPI/物理范围、既有FillParent回归及正常关闭恢复。
4. 可沿现有隔离harness补一个明确hidden-size分支，直接调用生产open/close与geometry readback；不得误用当前foreground controller。先完成实现和定向检查，再决定最小真实运行；不调用CUA、不使用AppleScript/CGEvent等新系统输入方式。隐藏原生几何与回收不代表可见UI/物理输入验收。
5. Main基线604522B，既有上限606381B；预计无需增加Main逻辑，不提高上限。Settings基线802653B，先守既有802953B；必要时最多增加1536B，新增milestone上限804189B，须保留旧门槛失败并解释实际成本，不删行为/校验或改原Vue/CSS凑体积。

前端与Core普通改动交非实施Terra复核；跨session布局/缓存/关闭接线交Astra限定审查，使用不可变after/diff/hash。作者文件不超过500行；先做职责检查，session_runtime接近500行须语义拆分，不堆策略。Cargo保持单一串行lane、locked/offline/j2；不做无关全量重测，无Git暂存、提交或推送。

参考调查：`output/renderer-next-frontier-r75-2026-11-02/frontend-findings.md`、`native-findings.md`。后续头像与唤醒黑名单仅记录为候选；旧主交互合同的过时缺口不能代替当前源码事实。
