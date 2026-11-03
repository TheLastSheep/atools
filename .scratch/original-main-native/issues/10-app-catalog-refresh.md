# 10: 新装、删除应用更新原版搜索列表

**What to build:** 应用目录发生变化后，原搜索列表及时刷新，旧删除路径失效；监听/扫描与退出回收有界。

**Blocked by:** R17预算与R19 catalog图标元数据（实现已满足）；可与锁屏待验事项并行。

**Status:** in-progress

- [x] Native事件先失效catalog再通知main，根与扫描预算不扩大（源码与定向检查；Tauri投递另验）。
- [x] owned目录实际增删改名/缺失根及重建/停止后callback捕获回收通过。
- [x] 前端单flight与变更竞态、warm-cache dispose guard及原loadCommands回调契约通过定向检查；真实页面另验。
- [x] 类型、相关回归、正式构建和固定预算通过（R21收敛为586524字节，预算未变）。
- [ ] 原生FSEvents→Tauri事件→原Vue刷新及图片/窗口验收单独记录。

契约：`docs/contracts/ztools-renderer-app-catalog-refresh-2026-10-27.md`。

证据：`output/renderer-app-refresh-2026-10-27/verification.md/json`。Main139+strict、Native watcher8/renderer108/catalog5/source8/icons15、Node30和workspace通过；正式第三次JS587111，仍超有效预算583字节，保持拒绝。已恢复R19 dist586470，并保存候选和全部失败日志；当前source不能借旧dist取得验收。真实Tauri事件/页面和窗口回归、预算收敛以及新的Native构建绑定仍待完成。

R21更新：预算及新构建绑定已收敛，当前source与正式dist一致；Main142/Node45/strict、正式JS586524及原Vue浏览器14检查/6截图通过，详情见 `output/renderer-resource-catalog-2026-10-27/verification.md/json`。上述R20拒绝与恢复记录为历史状态，保留失败而不覆盖；真实Native事件→Vue刷新仍未验，保持in-progress。

### R22 隐藏原页面实证补充

`output/renderer-catalog-native-2026-10-27/run-61da068fbc8e49a786d5d95da7c25dd4/catalog-native.json` 记录实际隐藏 Tauri 运行中的目录事件到原 Vue 列表更新：标题从初始1项→新增2项→删除后1项；原页面 `appListCalls` 为 1→2→3→3→3，adapter catalog events 为 0→1→2→2→2，独立 main-target witness 为 0→1→2→2→3。Native catalog 数量为 1/2/1/1/2。各阶段 main 均 hidden/unfocused、focus-gained/child/layout 为0，store非持久；删除路径拒绝且 TaskRun/history 前后均为0。dispose 后 observer 能看到一次事件，但 adapter/read 调用数不再增加。独立审查见 `output/renderer-catalog-2026-10-27/independent-review.md`。

该运行只支持本次隐藏 fixture 下的 FSEvents→source失效→main事件→原 Vue getApps/DOM 列表链路。Issue 10 保持 `in-progress`：可见页面、物理焦点/窗口与错误占位等验收仍未完成；R20 预算失败和恢复历史保留不变。
