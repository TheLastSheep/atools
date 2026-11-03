# 30：原版主搜索的插件变化刷新顺序与通信合并

**What to build:** 插件连续安装、更新或启停后，主搜索最终显示最新目录；较早的异步刷新不能在新结果之后回写旧目录。同一批变化合并刷新，避免逐项重复查询。

**Blocked by:** 28/29 已完成基础目录与持久状态切片；可立即处理。应用别名的真实链路验收仍保留在16，不由本票替代。

**Status:** verified-adapter-and-original-consumer-with-native-regression — R40，实际固定上游consumer的旧刷新回滚RED已转绿；Luna实施、Main独立测试/构建与原版页面、真实Tauri回归通过。完整可见UI与其它主程序能力继续开放。

- [x] 真实异步消费路径中，旧刷新迟到不覆盖最新结果；不修改固定上游 Vue/CSS。
- [x] 突发事件有界合并，不新增轮询或常驻进程；目录读取与回调不无限重叠。
- [x] 无效事件、回调异常、取消订阅和销毁仍正确隔离；尾随刷新不向已撤销订阅交付。
- [x] Main JavaScript 绝对预算保持593920B；相关类型/单元、原版浏览器及实际Tauri回归与来源绑定有证据。

最终Main593891B，增加31B、余29B；Settings782503B保持。受控20事件由20次回调合并为2次、2次list读取，最大并发1；不能把该边界计数称为Native压力基准。28文件221测试、strict、正式Main build、原版浏览器16检查均通过；R38及R39实际Native在相同最终资源下回归通过且owned资源回收。详细证据见[独立验收](/Users/harris/Desktop/atools/output/renderer-plugin-refresh-2026-10-28/verification.md)。

同步、插件执行及默认入口安排不变。可见画面、完整设置、应用别名Native链和Harris原包继续独立验收。下一步回到16，不以本票代替别名UI/存储/搜索纵向验收。
