# 47：原版默认内容高度与内置设置承载

**What to build:** 用户在原General修改或重置默认高度后真实保存；无缓存的owned Settings消费持久内容高度，正常关闭重开尊重原版缓存优先。回搜索保持自己的尺寸，不只写DB。

**Blocked by:** 已接通的General事务、owned Settings Child及关闭生命周期；实现和隐藏Native验收已完成，完整可见UI缺口继续独立保留。

**Status:** in-progress — R75实现/自动检查/独立复核与R76隐藏Native四新进程消费已通过；可见UI、物理输入、DPI切屏、NSPanel及跨平台仍开放，不能overall complete。ticket48仅 `complete-hidden-native-verification`。

- [x] 缺失542和显式/重置541分开（总600/599），finite小数/2001保存回读；不新增1200上限。原模板/CSS保持。
- [x] 原General保存/setter共用事务收据队列；changed一次patch、缺失重置541实际force-CAS补提交、失败reject与旧draft/session保护通过原组件合成DOM回归。
- [x] owned Settings真实消费原始requested d缓存；父窗/Child创建及重排统一macOS可表示q=round(round(d×s)/s)，父窗q+58，Childround(q×s)，DB/cache仍d。显式生产投影经新fresh四进程验证，不以±1或解释旧Parent根因替代。
- [x] R75 Core/布局/会话定向、双配置编译、正式预算、独立复核和Svelte无关保存保护19项回归通过；R76另保留生产resize顺序RED/14绿/双check、Main初始化及严格phase修复。
- [x] R76最终suite `602b36cf8d1749eb8dc75d7ac97387c8` 全部A-D通过：raw缺失→200.5→541→2001→不变；A/B/C当前/重开仍各自缓存高度，新进程按终态SQLite副本读取持久值。三段checkpoint SHA/raw一致、unknown保留、四integrity ok。
- [x] scale2实际父/Child：A1200/1084、B518/402（原d200.5、q201）、C1198/1082、D1898/4002；D真实parent裁剪。四进程exit0、source/binaryposttrue、close session/Child/layout/pending归零，保全后owned roots/bundles/seeds受控清理；Terra限定普通Window隐藏Native范围独立终验通过。
- [ ] 原General完整可见输入/reset/失败提示、像素/焦点与用户流程；合成DOM+隐藏Native未代替可见UI验收。
- [ ] 物理输入、DPI/跨屏变化、Windows/Linux、NSPanel；本次固定scale2普通Window非NSPanel，hidden/unfocused仅采样事实。

原R75 Native25源a630a041及其审查/日志保持原批次身份；R76最终Native31源scope `42904c53da140aafb47824a72a3b1f908f77b1933fb73b2cd945c2b273abb9a8`、binary `4b4bd28195e5565cae0f9e490fb3bad3028a20fe12fe3d15df4bd284dfd2e341`单独绑定。R76前六次suite失败保留，不重判旧B或命名首次SIGABRT根因。profile login-status是fixture替代、single-owned-child scheme不采numeric注册ID，不扩大为OS全局证明。

Main604522B/cap606381与Settings803857B/cap804189保持、未为R76重建；R75 Settings+1204≤事前1536且旧cap失败保留。默认Svelte未切换，插件后置、原Goal不整体关闭，无Git提交/推送。

合同：`docs/contracts/ztools-settings-default-height-2026-11-02.md`。R75实现证据：`output/renderer-settings-height-r75-2026-11-02/`。新增验收：[R76总报告](../../../output/renderer-settings-height-native-r76-2026-11-02/verification.md)、[四进程事实](../../../output/renderer-settings-height-native-r76-2026-11-02/live/representable-layout-602b36cf8d1749eb8dc75d7ac97387c8/execution.json)、[独立终验](../../../output/renderer-settings-height-native-r76-2026-11-02/reviewer-terra.md)。
