# 13: 原版主搜索框拖动

**What to build:** 原搜索框空白处可拖动主窗口，移动时保留尺寸，退出/取消不遗留尺寸锁；高频鼠标事件通信有界。

**Blocked by:** 11/12 已完成；同版本 Fuse basic 等价和实际资源减重作为本票前置。

**Status:** DONE — hidden Native drag and active-lock hide/navigation lifecycle verified; visible and broader platform evidence remains incomplete.

- [x] Fuse 两处实际搜索配置完整结果等价，正式包资源实测且预算不变。
- [x] 原 Vue 三方法接通 main-only 几何能力，坐标/锁定/动态改高/生命周期有界。
- [x] 单在途/最新坐标/锁屏障和取消/失败/dispose 已验证。
- [x] 真实隐藏原页面鼠标事件到 Native 几何链通过；可见/物理多屏仍是未验范围。

契约：`docs/contracts/ztools-renderer-window-drag-2026-10-27.md`。

## R23 实际验收

Native run `54aaf1a83f3642219e6d9f5d668fc624`：`output/renderer-catalog-native-2026-10-27/run-54aaf1a83f3642219e6d9f5d668fc624/report.json`、`window-drag-native.json` 与 `catalog-native.json`。隐藏原页面五阶段几何为 baseline `(356,608), 800×61, unlocked` → dragged `(376,623), 800×61, locked` → resized `(376,599), 800×85, locked` → released 同位置/尺寸且 unlocked → restored `(356,608), 800×61`。scale factor 为 2。全程 hidden/unfocused，focus-gained、child、layout 为 0，DOM focus=false，WK store 非持久；3 次 move API 调用合并为 2 次 Native dispatch（coalesced=1），pending/errors 均为 0，catalog 仍通过，clipboard/TaskRun/history 均为 0。

Native PID 93513 exit 0；owned fixture root 和 bundle 已清理，source/native/binary/receipt 稳定。Root 汇总的 Native 1100-input/fresh-example、Main154+strict/最终focused33、Fuse4、Node最终34、workspace/legacy-only/fresh-build 检查均通过；headless browser run `326253c7` 通过14项并留6张截图。Main JS 为585828 bytes，effective cap 586528、余量700；比 R21 的586524少696 bytes。预算、manifest 与压缩策略未改。

此 run 没有实际触发锁定中的 Native hide/navigation 中途动作；这些清理路径有源码、状态测试及独立审查证据，不等于本轮真实 Native 生命周期实测。可见窗口绘制、物理/多屏输入、跨平台及重启位置保持未验证。本票所述本地 hidden slice 已完成，不能据此把整个原版主程序同步目标标为完成；默认 Svelte 未切换，主程序优先，Harris 插件后置。

## R24 生命周期追记

上段明确保留的是 R23 证据边界。R24 的真实 hide/navigation 中途生命周期由 ticket 14 的 Native run `066cc4fd348641688c2865b3e757910f` 补验：锁中调用生产 `hideWindow` 后 Native 解锁，同页 redrag 再次成功；锁中完整同源 navigation 后，旧文档清理锁，新文档以原位置启动并能继续拖回初始几何。十阶段文档身份、hidden/unfocused、零 focus-gained/child/layout 与资源回收门槛通过。详见 `.scratch/original-main-native/issues/14-window-drag-lifecycle.md`。这收敛本票的隐藏生命周期 pending，不扩展成可见窗口、物理/多屏、跨平台或重启位置验收。
