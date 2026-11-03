# 09: Harris 贴图页 drag / no-drag 区域适配

**What to build:** 兼容原版贴图页的 Electron CSS 拖动区域，复用 native self 的 source/document/owner、权限和 TaskRun 通路启动原生窗口拖动。

**Priority:** Harris 原包核心交互，接 Task07；优先于通用 framed 尺寸 Task08。编号不表示执行顺序。

**Blocked by:** None for source investigation and implementation. 真实指针拖动仍按用户指令待原生验收。

**Status:** macOS code-contract slice complete — real desktop / imported CSS / other platforms pending

## 已确认的静态事实

- 外部 Harris Snipaste 2.0.1 的 `dist/paster.html` 与根 `paster.html` 字节相同；`#drag-surface` 声明 `-webkit-app-region: drag`，HUD 按钮及菜单声明 `no-drag`。
- 当前 native child 宿主没有对应 CSS 区域到原生拖动动作的接线；主界面组件中的 app-region 样式不能证明插件子窗支持。
- 本地 Tauri 2.11.2 `WebviewWindow::start_dragging` 已存在，但项目 native BrowserWindow action 路径尚未调用它。
- 尚未执行真实 GUI 拖动；以上为接线差距，不能表述为 OS 实测失败。

## 先核实的边界

- 不先假定 WebKit 的 computed style 会返回 Electron 属性；核对现有资源/CSS 适配及可用解析方式，正确处理外部样式、层叠、后代 no-drag 和动态内容，避免按插件 ID 硬编码。
- native 拖动依赖的指针事件与用户手势时序、Tauri/UI-thread 调用及超时语义必须查源码，不能用伪造 OS 输入绕过问题。
- 主窗口、hosted preview、普通按钮、滚轮缩放、上下文菜单及原窗口控件不应被拖动拦截。
- 此项是窗口移动，不是 `webContents.startDrag` 文件导出；暂缓且默认禁用的文件拖拽不因此开启。

## 验收要求

- 保持原包字节、不暴露 Tauri/global native token；只控制当前确切 self 窗口，并拒绝旧文档/兄弟窗口/已销毁来源。
- 一次有效拖动手势触发有界的原生请求，不按 pointermove 逐像素通信、不新增 Node 或周期轮询。
- 通过真实编译桥与原版页面验证 drag/no-drag 分派、事件与生命周期；真实透明原生窗口的连续拖动、点击与右键交互单列待验。

## 本批接口与实施边界

- 独立 native CSS 转换器在解析前把区域属性名替换为 `--atools-native-app-region`，保留声明值、顺序、优先级和其他 CSS；原文件字节不变。初始 native 文档覆盖 style 块、style 属性及已内联的包内 stylesheet，运行时复用既有资源管线和 CSSOM 入口，不增加观察器或周期扫描。外部 `@import` 正文暂未覆盖，不据此宣称完整 CSS 兼容。
- 仅当前 native child 的闭包通过内部 `startDragging({startedAtMs})` 发起一次请求；不扩公开 Electron handle。`startedAtMs` 在原 DOM handler 同步入口记录，作为额外的迟到拒绝条件，不作为可信手势或权限凭据。生产事件必须在原 realm 检查可信、主鼠标左键和区域，普通 main / hosted 不安装该能力。
- macOS 保留原生真实 LeftMouseDown，检查确切 NSWindow、左键仍按下、非 Control、250ms 时限、按下早于该 DOM handler 和 intent 准备、一次消费；最后一个 native 窗销毁时移除监视器。该缓存与暂缓的文件拖放功能独立。DOM 与 native 时间均为同机整数毫秒，时钟异常保守拒绝；同毫秒的多次实体按下仍属相关性精度边界。
- 启动前在 UI 回调重验当前 intent / TaskRun / source / document / owner / renderer / permission；曾弹权限提示的旧手势不延迟执行。排队和检查中请求可取消；启动 ACK 只表示接受原生拖动启动，不代表用户已松开鼠标或窗口移动验收通过，避免套用通用 5 秒动作等待。
- 本批不执行 GUI、AppleScript、App 或原生探针，不以合成事件冒充可信输入。其他平台的原生拖动留待各自实现和验收。

## 本批独立验收

主 Agent 使用产品 Node 22.23.3 运行24个文件、185项前端回归，类型检查0错误/0警告、生产构建通过；Rust相关41项基线、后续3项exact-self与6项手势过滤复验通过，工作区编译通过。两个旧JS脚本修正了临时依赖和过期源码位置检查，独立复验均通过，原行为断言保留。

启动JS为432,238/573,440字节，与上批相同；插件按需文件728,558字节，仍有既有大chunk警告。29个代码文件均≤500行、无尾随空白，冻结源哈希复核通过。原版2.0.1页面和services.cjs核对固定哈希；页面合同使用显式测试手势seam，preload导出对象使用兼容shim，不代表Node sidecar/文件系统/真实指针拖动业务通过。

外链样式正文、CSSOM文本反射、64层以上嵌套、真实跨平台GUI和整应用资源仍有明确边界；本卡与总体目标不计完整兼容完成。详见[验收记录](../../../output/native-drag-regions/verification.md)。下一独立切片为Task08运行时framed尺寸。
