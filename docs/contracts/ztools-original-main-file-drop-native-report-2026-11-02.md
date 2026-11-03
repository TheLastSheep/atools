# R77 catalog附加Main拖放观测

只在完整managed catalog profile下固定`ATOOLS_MAIN_DROP_PROBE=1`启用；其它值/入口早拒绝。复用原catalog生命周期、源码/二进制归属、150秒外部期限和清理（现有runner的caseTimeoutMs=150000），不创建新通用harness。任何probe错误使Native/catalog非零；旧catalog默认不变。文件固定为`${ownedRoot}/main-drop-report.json`，必须在终态后、owned root清理前独立验证和复制。

固定输入在catalog watcher roots之外：`r77-main-drop/file.txt`、`r77-main-drop/folder`，另混入missing与重复file以验证过滤/顺序去重。只用元数据，不读正文。初始及恢复query为`ATools Catalog`，文件输入为空。成功结果原模板是一组`.pasted-files`、首文件名`file.txt`和数量badge 2；不能虚构第二个文件DOM节点。

## 精确报告

顶层及各嵌套对象均闭集。UUID/owned root/pid必须与同次catalog执行事实匹配，不以passed代替值验证：

```json
{
  "schemaVersion": 1,
  "kind": "renderer-main-file-drop",
  "inputSource": "rust-injected-native-drop",
  "contextObservation": "accepted-updateLaunchContext-call",
  "runId": "<same-run-uuid>",
  "pid": 1,
  "root": "<same-owned-root>",
  "passed": true,
  "errors": [],
  "stagesCompleted": ["registered", "injected", "main-observed", "input-restored", "disposed"],
  "observed": {
    "targetRegistered": true,
    "nativeDropAccepted": true,
    "metadataFiles": 2,
    "mainChipCount": 1,
    "mainFileCount": 2,
    "chipNames": ["file.txt"],
    "launchContextQuery": "",
    "launchContextFiles": [
      {"relativePath": "r77-main-drop/file.txt", "name": "file.txt", "isDirectory": false},
      {"relativePath": "r77-main-drop/folder", "name": "folder", "isDirectory": true}
    ],
    "inputBefore": {"query": "ATools Catalog", "files": []},
    "inputAfterRestore": {"query": "ATools Catalog", "files": []},
    "targetRevoked": true,
    "actualWorkers": 0,
    "pendingBatches": 0
  },
  "guiAcceptance": "unverified",
  "osDropAcceptance": "unverified"
}
```

`launchContextFiles`来自原Main实际接受的`updateLaunchContext`调用：先调用原函数成功才记录原参数，严格确认每条属于ownedRoot的两个固定输入后转相对路径。它证明原App到真实接口的已接受调用，不伪称私有Native内存getter或后续工具执行。独立checker核固定数组、DOM值和前后恢复；在清理前对固定owned路径独立stat核文件/目录类型。生产路径不写这些输入到日志/审计，私有probe不捕获用户文件。

原生target/worker/pending必须来自实际模块读回。进程exit、source/binary稳定、旧catalog全部阶段、身份/归属与清理仍按原runner门禁，附加报告不能覆盖旧失败。缺报告、错run/pid/root、未知字段、wrong array/name/type/query/stage、非零worker或pending均失败并保留现场。

Native注入走同一实际Main binding/生产元数据与targeted事件，不能把该输入称OS拖放。合成浏览器、隐藏WKWebView、真实物理拖放和可见/跨平台分别记载，整体目标保持开放。
