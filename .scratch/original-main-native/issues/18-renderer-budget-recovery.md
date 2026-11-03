# 18: 主程序资源回收与原双视图输入验收

**What to build:** 保留原界面、完整拼音与输入协议，在既有体积门槛内构建当前主程序，并实际验证主搜索框与设置页双向交互。

**Blocked by:** None。17的实现及独立单元回归已具备；本票解决其预算门禁并推进原界面验收，不把17未完成的原生/可见验收视为已通过。

**Status:** completed for the defined build/browser slice — Main 587776 B within unchanged caps; original Main 15 checks and original dual-page input 10 checks passed. Overall renderer remains partial for the updater getter; real Tauri/visible acceptance is tracked separately by 19. Evidence: `output/renderer-budget-recovery-2026-10-27/verification.md/json`.

- [x] 构建期工具版本、锁文件、完整transitive文件和helper身份固定并在发布前复验；不新增应用运行时依赖。
- [x] 保留getter、pure调用参数、异常、异步、导出和公开键行为；真实语义测试通过，禁止不安全压缩或属性混淆。
- [x] 原总量及增量门槛不变，正式发布的当前Main产物通过，并与当前源码绑定。
- [x] 原Main输入筛选、反向设值、IME最终值、切页/代次、关闭/重开与冲突草稿通过自有双页面浏览器验收；资源清理真实完成。
- [x] 原Main已有搜索/拼音/高亮/主题回归保持；浏览器与Tauri/OS证据分开记录。

Root独占正式构建和实际浏览器/Native运行；Luna负责有明确归属的实施与只读审查，不能派生。保留旧失败证据、默认Svelte入口与所有共享工作区改动，不提交或推送。
