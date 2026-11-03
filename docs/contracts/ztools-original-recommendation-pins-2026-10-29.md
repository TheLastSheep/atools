# 原版推荐结果固定持久化

状态：R64实现及分层验收完成，真实Native系统菜单/可见流程待验；见`output/renderer-recommendation-pins-2026-10-29/verification.md`。工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；上游只读固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。主程序优先，插件执行后置。

## 行为与边界

原 Main 推荐项右键“置顶/取消置顶/排到最前”会保存独立的 `recommendation-pinned` 数组。当前宿主拒绝该写入。本批补齐原 Store → adapter → Main 专用命令 → Core/SQLite 的持久化；不改原 Vue 模板/CSS，不激活插件，不合并进 `pinned-commands`/history 的 revision。

记录必须有字符串 `path/name/type`，可选字符串 `featureCode/pluginName`。原插件身份使用 `[pluginName || path, featureCode || name]`；其他类型使用 `[type,path,name]`。存储保持顺序、重复记录、额外JSON字段及未安装插件引用，不把记录投影成五字段对象，不把路径作为执行授权。损坏的已存记录明确拒绝写入，不静默清理。

继承的重复身份边界：原版排序map取最后一个索引，但取消/前移操作首次匹配项，因此重复身份下前移未必在画面排首、取消一次后也可能仍显示已固定。本批保留原始数据和首次匹配操作，不宣称修复该上游显示语义。

## 固定接口

- Core 独立固定key `ztools-renderer:recommendation-pinned`；`mutate_renderer_recommendation_pins_guarded(expected_raw:Option<&str>, mutation, guard)` 返回 `{changed:bool,raw:Option<String>}`。expected null仅表示无记录；其他情况按完整原始字符串CAS。存储JSON null视为损坏。事务Immediate获锁后检查guard和expected，冲突/错误不得写入。
- mutation为严格tagged union：`{kind:"append",pin:...}`、`{kind:"remove",index:...}`、`{kind:"moveToFront",index:...}`或`{kind:"noop"}`，拒绝未知字段和越界索引。既有记录以RawValue保留原始行JSON，仅追加/删除/移动准确下标，不把JS解析后的未知大整数或高精度小数写回。同序列noop或第0项前移保持完整raw不变。无记录的noop保持无记录。
- 最大4096条、完整UTF-8 JSON 128KiB、path16KiB、name4KiB、type64B、featureCode/pluginName各1KiB；JSON深度8、节点8192。必需字段按原版最小字符串形状验收，不擅自trim/去重/限制未来type；可选字段存在时须为字符串。额外字段只作被动JSON，仍受总预算约束。
- Native命令 `save_renderer_recommendation_pins(expected, value)` 的expected是必传string|null，value为上述mutation；仅接受实际main Webview及其main父窗。共享Core事务，在阻塞worker中执行。成功回 `{version:1,changed:boolean,raw:string|null}`，为下一次CAS提供有界的无损基线；固定错误不泄漏底层记录。专门命令以外的未知namespace写入继续拒绝。
- adapter通过已存在的启动批次/读模型取得原始expected；有界队列按提交顺序处理，单次保存只发一次配置IPC，不另发列表重读或通知。调用时对desired做受限plain JSON独立副本；依据原版身份序列仅识别追加一项、移除首次匹配项、首次匹配项前移或noop，不支持任意数组编辑。已有行metadata不回传写入，JS只比较身份；raw回执通过形状/大小验证后更新此域原文和解析缓存，使晚到旧读不能回滚。失败不接受本地缓存，原Store执行原有回滚；不声称宿主已修复上游多次乐观写失败的所有并发回滚问题。
- 未知扩展字段名不限制为256字符，但仍受完整JSON/节点/深度预算。搜索偏好等其他域原有字段名限制保持。无损方案采用serde_json的raw_value功能，不启用全局arbitrary_precision，不引入额外数据库或进程。
- dispose后不启动排队IPC/不接受迟到回执；已提交Native的原子事务可能完成，不假装页面关闭能撤销已提交写入。保存该域不触碰history、主面板pins、别名、插件或General配置。

## 验收与预算

1. 真实SQLite固定/移动/取消、重开、跨连接raw CAS、noop raw不变、非法/超限/guard拒绝，以及其他域、长扩展键、重复记录、超JS安全整数和高精度小数原文保留。
2. Native主窗边界、请求/回执与固定错误；前端一写一IPC、输入独立副本、失败/旧读/关闭生命周期及未知key拒绝。
3. 固定上游实际推荐Store/页面验证置顶、前移、取消及失败回滚；含插件名稳定而目录变化的身份；只用固定夹具，不执行原包插件。
4. 定向类型/回归、workspace及正式构建，先按现有Main593920B与Settings预算测量；新增功能超限必须保留失败并说明实际增量，先评估同职责复用/去重，不能删除校验或伪造旧预算通过。不得以静态字节代替延迟/CPU/RSS结论。
5. 浏览器合成RPC、Rust/SQLite与Native GUI分别记证据；未完成可见/物理/跨平台、默认Vue入口和Harris原包范围继续开放。
