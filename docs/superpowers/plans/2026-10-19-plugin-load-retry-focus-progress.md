# B46 插件加载失败原位重试与焦点交接进展

本文件记录 B46 实施与验证范围。最终 root 验收状态以交付清单为准；真实原生工作流仍未通过。

## 用户可见行为

插件面板加载失败时，错误说明和可键盘操作的“重试”控件留在原位。用户显式重试后，控件保留并显示忙碌状态；当前加载完成后，若重试按钮仍持有焦点，允许将焦点显式交给新 iframe；若用户在等待期间把焦点移到诊断摘要等其他控件，重试完成不会抢回焦点。原有无人占用焦点时的规则保持不变。重复点击/按键被单飞门禁拦截；再次失败后原控件仍可用。

关闭面板、切换插件和过期的异步结果受现有 generation/owner 检查约束。重试覆盖启动阶段失败；页面启动后的终态撤权仍沿用现有退出提示。重试会重新运行插件页面和 preload 初始化，不能保证第三方初始化幂等或无副作用；宿主不会主动重复成功的 `activate_feature`、picker/save 或其他业务命令，也不自动授权。

## 实现边界

13 个 owned 源文件（7 修改、6 新增）由 root freeze v4 绑定；最终快照在证据包 `source/after-v4/`。重试状态机、错误组件、焦点判定及浏览器 fixture 保持在独立模块/测试中。`PluginPanel.svelte` 由 8,360 行增至 8,373 行，仍超过 500 行文件边界；这是保留的既有宿主拆分债务，本批没有把新状态机职责堆入其中。其余 owned 文件均低于 500 行。

本批未增加自动重试、空闲轮询、全局监听、新依赖、启动预热或超时预算。重试不重新调用 `activate_feature`。初始生产 JavaScript 为 365,513 bytes，相对 B44 增量为 0，低于 573,440 bytes 预算。Explicit selected sources 是审查输入集合，不代表完整编译器或依赖闭包。

## 验证证据

权威 root 汇总为证据包 `metadata/verification-summary-v1.json`，最终源冻结为 `metadata/source-freeze-v4.json`。验证结果：

- 定向测试：6 个文件，61/61 通过。
- 完整前端测试：185 个文件，1,762/1,762 通过；Svelte 检查 0 errors / 0 warnings。
- Root 实际执行的离线 Cargo workspace check：退出码 0，4 条既有 warning；该检查绑定 worker v4 源冻结。最终 v6 的 Rust 字节与 worker v4 相同，因此复用这次 root check 作为最终 Rust 验证。
- host view、back-to-search、escape-policy 回归均退出码 0。
- 浏览器最终 run `af2be4b9-69bf-4db4-9b18-abbe3bb0aa6f` 通过。真实生产 `PluginPanel` 在隔离 Chromium 中配合受控 Tauri bridge 和本地 fixture 页面运行；覆盖显式 Space 重试后成功焦点交给唯一 iframe、busy 单飞、二次失败、420/800 宽度以及用户移焦到诊断摘要后的负向焦点保护。三张截图的 SHA、尺寸由 root 核对并查看。
- source post-verification 显示 1,567 项选定输入无漂移；HEAD 未变化；未执行 Git mutation。

证据包保留了 v5 红测：run `57597406-3474-4cb9-b51b-7d03b8bc0c3c` 的新增成功 iframe 焦点断言发现真实缺陷——加载虽成功，重试按钮的焦点没有交给 iframe。该失败没有被升级为通过；修复后才由最终 v3 浏览器 run 验证正向焦点路径。独立只读 review v3 对冻结 v6 记录 0 个确认 P1/P2。

## 验收限制与后续

浏览器验收使用受控 bridge 和纯本地 HTML fixture；它没有执行原生 UI/OS 输入、真实插件业务操作或原生权限行为，也没有覆盖任意第三方插件的初始化副作用。固定 loopback 流量在本次观测范围内；不声称完成全浏览器网络审计。负向焦点检查不单独等待后续 iframe load event，来源守卫和 root 报告中的焦点结果仍应按证据范围解读。

本批没有新增通过的原生编辑器输入或 ZTools 插件业务工作流；多数插件直接可用性验收为 false，release validation 与 formal acceptance 均为 false，goal 仍 active。B45 已知的原生启动/前台验收缺口及一项历史 formatter 字节保真差异只保留为既有状态引用，本批没有重测或恢复。下一步应继续验证用户可直接进入真实插件功能的端到端路径，并将原生与浏览器 mock 证据分开记录。
