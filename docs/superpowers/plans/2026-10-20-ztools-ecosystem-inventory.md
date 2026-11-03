# ZTools 插件生态分母盘点

该工具生成本机 Git 快照的只读目录清单，不运行插件、不判定兼容性。示例快照 HEAD `2d47bd91011b6be872eef1d7c56b4c6b57a93b3d` 有 153 个上游顶层插件目录：72 个根目录有 `plugin.json`、75 个只有 `public/plugin.json`、6 个两者都没有。另有 27 个不在该 HEAD 的本地直接 manifest 目录。上述分类是结构计数，不是可安装、可构建或可用的比例。

示例快照工作区有跟踪插件文件改动，工具将 HEAD 清单和工作区 manifest 树分开记录；它不清理或重置本地改动。当前没有可绑定到这份工作区的兼容率或运行时阻塞百分比，历史审计文件仅作来源提示。

```sh
python3 scripts/inventory-ztools-ecosystem.py \
  --repo /path/to/ZTools-plugins \
  --out /private/tmp/ztools-inventory-2026-10-20-run-01
```

`--out` 必须是不存在的新目录，并且必须位于正在盘点的真实 Git 根目录之外；脚本先解析 Git 根和输出路径（包括现存父级符号链接），拒绝仓库根本身或仓库内路径后才创建目录。再次运行请换一个仓库外的新目录。输出为 `inventory-v3.json`，`schemaVersion` 为 `3`。相较 B90 历史 v2，未跟踪目录字段改名为 `untrackedLocalStructuralCandidates`，不再使用暗示完整性的名称；旧 v2 归档不变。工具在开始时固定完整 Git HEAD，所有 HEAD 清单读取都使用该 SHA；写出前重查 HEAD、跟踪 manifest 树和本地非跟踪 manifest 树，任一变化都不生成清单。`untrackedNonIgnoredFilesUnderPlugins` 对应 `git ls-files --others --exclude-standard`，忽略文件不计入该数字。27 个本地目录只是结构候选，不代表完整包、可构建或可用。未跟踪插件的 `main` 只作结构检查：拒绝绝对、盘符、反斜线、点/遍历路径，并逐段拒绝符号链接，不跟随到插件根以外。

本盘点不会测试 build、加载、权限、API、交互或业务路径；不应从 manifest 存在推断插件可用。
