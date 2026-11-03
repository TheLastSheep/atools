# R32：原设置页的应用搜索固定

主程序优先。复用现有 Core app-state、SQLite、revision 和 Main 通知；不重写原 Vue/CSS，不新增 Main 渲染通信、插件进程或任意设置写入。工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。Luna 分模块实施，Root 审查、测试、正式构建及实际隐藏验收；其他已有工作全部保留。

## 产品接口

原 AllCommands direct/app 菜单调用 `internal.pinApp(command)` 或 `internal.unpinApp(path, undefined, name)`，然后重新读 pinned-commands。Child 仅把真实 direct/app 对象映射为 path/name；不接插件 feature、不接受任意键、历史或 RecordLaunch。unpin 的缺省 name 映射为 null，保留既有按 path 删除语义。

只增加固定 Child operation `mutateSearchPin`，沿现有 call_renderer_settings 的 caller/session/bundle 校验和32准入：

- pin payload exact `{operation:"pin", app:{path:string,name:string}}`；
- unpin payload exact `{operation:"unpin", path:string, name:string|null}`；
- reply exact `{version:1,revision:number}`，revision 必须为 JS safe integer；失败保持结构化拒绝，不能伪成功。

路径、名称和JSON/UTF8上限沿既有 Main app-state 校验及32KiB单次设置operation预算。pin 复用当前 catalog 成员检查；unpin 允许清理既有路径，不增加启动应用、系统权限或文件副作用。

## 写入、缓存和退出

- Core 增加 `apply_renderer_app_state_guarded(mutation, guard)`；原方法委托 always-true guard。guard 在取得 SQLite Immediate 事务后、任何状态写入前执行，false不改记录/revision；未通过 guard 的排队请求不能在 Child 关闭后落盘。Core 仍不依赖 Tauri。
- Native 持有既有 session write_gate、operation/call/write accounting；异步等待及阻塞工作不占主线程。提交 guard 通过后的既有 owned 事务即使页面关闭也完成并计入回收。
- 复用现有 Main-only app-state 变更事件，事件必须来自实际提交快照；不另造 pinned namespace、Main listener 或系统应用扫描。
- Child 的 commandSettings 不可变快照须失效。Native 在同一 command-settings read gate 下协调写入与失效，防止旧进行中读取在提交后重新缓存；closed buffer 不得复活。Child 用新读取显示实际提交状态，不以本地乐观值当成功。
- Child bridge 只开放 pin/unpin 的窄接口，有限在途、dispose/liveness及未知提交结果保持保守；不放宽 general.dbPut。

## 原生验收扩展

沿 R31 隐藏profile扩到schema v3十二阶段：在 mainClear 后增加 pinSearch，在 freshReopen 后增加 unpinSearch；R31旧session请求拒绝及所有旧门禁保留。原 Main/Child DOM 菜单必须实际被点击，不直接调用新 write API代替产品操作。

顶层新增 exact `searchPins` 证据：八个布尔 `initiallyEmpty,pinStored,pinReadBack,mainPinned,unpinStored,unpinReadBack,mainUnpinned,historyUnchanged`，及三个 safe integer `initialRevision,pinnedRevision,unpinnedRevision`。成功必须八项均true、revision逐次+1。

- 原 Child 选择目标的“固定到搜索”，从同一临时SQLite读到该目标固定，Child公有dbGet读回匹配；公有outPlugin后原Main实际DOM显示固定目标。
- 重开后原菜单显示“取消固定搜索”，真实点击并从SQLite/Child重读证明清除；再次公有outPlugin后原Main固定组不再含目标。
- 两次写入前后历史不变，只有实际目标固定变化；名称、路径、输入原文及原始错误不写报告。原始状态与目标仅在内存核对。
- schema1/2旧报告不能冒充新验收。来源/预算、AppKit事实、非持久WK、严格probe、fresh receipt及owned cleanup门禁继续全部生效。

## 性能和交付

Main JS 不应变化，继续589758/589824 B。Setting emitted有效上限779885 B（baseline771693+8192，绝对786432），新增内容必须在原预算内，禁止删原UI或静默改预算。正式构建、严格类型、Core guarded事务和Native相关测试、Node正负验证器、浏览器/真实原生菜单链分别记录证据。全量可见材质、物理键盘、完整禁用命令/插件能力不因本切片通过而完成。
