# R23 主搜索框拖动与资源分配

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上一轮 R22 为 progress；整体目标保持 active。

## 实际交互

固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a` 的 SearchBox.vue 722–776：空白处 mousedown → getWindowPosition → setWindowSizeLock(true)，mousemove → setWindowPosition，mouseup/buttons=0 → setWindowSizeLock(false)。输入框和 search-actions 不拖动，mouseup 等待位置读取时取消则不进入拖动。保持原 Vue/CSS 不变。

## 资源前置

主 JS 当前 586524，有效门槛 586528。先验证同版本 Fuse7.1.0 basic 对本页面两个实际配置/字符串搜索的完整结果、score、matches 与普通构建等价，再精确 alias bare `fuse.js`。不改 pinyin 数据范围、压缩策略、依赖版本或预算；正式构建实测减重后才计入新交互资源开销。无扩展搜索调用不能被泛化为 basic 支持完整 Fuse API。

## 宿主接口

一个 main-only 命令 `renderer_window_drag`，参数 `{ request }`，封闭 tagged enum：

- `{ operation: "position" }` → `{ x:number, y:number }`，主窗 logical outer position。
- `{ operation: "lock", locked:boolean }` → `null`，捕获当前 logical 尺寸；重复 true 不覆盖尚未更新的锁定几何，false 保留位置并恢复锁定尺寸后清理。
- `{ operation: "move", x:number, y:number }` → `null`，保留负坐标，有限且可表示；锁定期间保留捕获尺寸，原 expand/reset 成功后更新锁定尺寸。

只接受 caller Webview/main 和 parent Window/main；本地页面来源检查复用现有正确模式。不得允许前端传窗口标签或任意系统目标。仅为 UI 呈现，不发通知、不启动 Node、不产生鼠标移动 TaskRun。所有几何 OS 工作在主线程、有界准入，不持有状态锁跨 OS 调用。尺寸锁不是 set_resizable，不能阻止搜索结果主动变高。

Native 状态由 app 管理，最多一个锁定尺寸；主页面开始导航、主窗隐藏/销毁均清理，不轮询。位置以 actual scale factor 转换；异常 scale、非有限/不可表示坐标、未知字段/动作拒绝，不猜坐标。多屏 DPI/其他 OS 需要各自实际验收，不能由 macOS 检查代替。

前端独立 windowDrag 模块承载查询/锁/移动排序、计数与 dispose。getWindowPosition 返回 Promise，setWindowPosition/setWindowSizeLock 保留 void。位置更新最多一个 native 在途，每个保序区间保留一个最新待处理坐标；不能每次 mousemove 无限入队。lock/unlock 是保序屏障，正常 unlock 在最后一次待处理位置完成后；饱和时丢弃旧控制/移动为最终 unlock 腾位并计数。全队列18项、锁屏障8项、每个合并读取组32个waiter。dispose 清除待处理移动/标记迟到回执，不再调度移动；Native 生命周期清理为最终防线。错误计入明确诊断且无 unhandled rejection。

## 实施归属与验收

Root 负责接口、lib/registry/app_builder/window 接线及关键 diff 和检查；Luna 分属 Fuse 构建与等价检查、Native window drag 模块、frontend module/adapter/types/test，不继续派生子代理。新增/扩展作者文件 ≤500 行。代码写入前各自核对仓库/实际分支/工作区和已有改动，互不覆盖。

先跑实际两个 Fuse 构建等价检查、前端关键竞态/失败/释放检查、Native schema/几何/权限/生命周期定向检查，再 frontend strict/正式 budget build、workspace check。Root 唯一执行 Cargo/build/实际 Native。真实隐藏主窗验证原 Vue 鼠标事件→生产 IPC→位置及尺寸、动态改高/释放与无前台；锁屏时不请求 show/focus，不用 AppleScript/CUA。隐藏合成鼠标事件不是物理鼠标或可见多屏验收。

当前 ATools 在 hide/toggle 记忆进程内窗口位置；上游按显示器延迟保存的位置持久化语义另行补齐，本票不冒充完成重启记忆。可见 UI、物理鼠标、跨平台以及完整目标保持待验。

## 本地验收结果

见 `output/renderer-window-drag-2026-10-27/verification.md/json`。实际隐藏Native run `54aaf1a83f3642219e6d9f5d668fc624` 完成 baseline/dragged/resized/released/restored；DOM与Native均hidden/unfocused，3个移动事件合并2次调用，61→85的inner高度在释放后保持，再恢复初始位置/尺寸。状态锁统一为logical inner尺寸，位置为logical outer；同进程catalog回归、退出回收通过。活动锁期间hide/navigation中途动作仍只有接线审查和状态单测，本轮没有实际执行这两个Native流程。

Fuse实际两个构建等价及正式包通过；加入新交互后全部JS585828，比R22少696，原manifest预算完全未改，余700。RootNative136、Main154及最终focused33、Node34、Fuse4、browser14、strict/正式构建/default与legacy-only/fresh Native build通过。保留前三编译/serde断言失败与首次旧精确体积preflight；后者未启动App，现按实际chunk字节核对provenance并保留双预算负例。完整目标继续active。
