# 44：原版设置快捷键临时录制

**What to build:** 在原快捷键控件内录制 Option/Alt+Space；录制完毕、取消、离开或超时后恢复原主键，保留普通 DOM 录制和既有保存逻辑。

**Blocked by:** 33 原版主唤起组合键、05 原版同窗设置及既有 R69/R70 Settings 接线。

**Status:** in-progress — R71 实现、定向自动化及独立复核通过；真实系统热键与可见原控件端到端仍待验，不据模拟边界关闭本票。

- [ ] 原控件开始录制，原生捕获一次后经既有保存流程生效；普通 DOM 输入仍可用。
- [ ] 不注销原主键或外部占用；迟到、重复、关闭及主键修改不会误投递或遗留临时 key。
- [ ] 取消、卸载、超时与退出回收；失败有明确反馈并可恢复。
- [ ] 定向行为测试、正式构建与独立复核；实际系统录制、物理输入和跨平台证据分开记录。

合同：`docs/contracts/ztools-hotkey-recording-2026-11-02.md`。

R71证据：`output/renderer-hotkey-recording-r71-2026-11-02/verification.md`。最终前端受影响23项、Native热键94项、正式资源reader19项及两种workspace编译通过（不合计重叠组）；Terra/Astra限定范围无剩余发现。原模板/CSS及Main保持，Settings801929/801964B。暂无本批实际OS录制/连续两次/主键恢复或物理键盘结果。

R72补齐manual-only真实热键服务、严格录制/保存准入和有界观测。定向测试、fresh构建及隔离期限退出/回收通过；CUA getApp 请求15秒、实际阻塞2942.5365秒，未发生任何UI动作，witness为空。因此真实录制及活跃快捷键释放仍未验，不关闭本票、不重复同一失败控制链。见 `output/renderer-hotkey-native-r72-2026-11-02/verification.md`。
