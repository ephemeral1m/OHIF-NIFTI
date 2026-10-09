# ReX 报告与 Finding 工作台（首版）

本地部署使用“报告优先”：左侧始终保留当前清单病例；右侧在“报告”和“标注与 AI”之间切换。报告保留英文原文及来源，不自动翻译或改写。

查看器顶栏使用统一深色风格，保留原 OHIF 工具注册、菜单、撤销和重做。左侧病例切换直接在工作台内完成：准备阶段保留原画面，验证首层后替换视口，默认以 Stack 打开新病例；不再跳转检查列表。准备失败或取消会保留当前病例。未保存修改需要确认，准备过程中发生晚到 AI/编辑更新则取消切换并保留更新。旧病例的标注、撤销历史和共享体数据缓存会在新视图就绪后清理。

## 样本准备与打开

运行 `prepare-workspace.py` 后生成：

- `local-data/rexgroundingct/rex-workspace.json`：5 例 CT、13 个 Finding 及两种报告来源。
- `deploy/local/rex-sample.compose.json`：只读挂载 5 份原图和 13 份已验证的三维 mask。没有挂载整个数据盘。

`deploy/local/Start-Local.ps1 start` 会在上述 override 存在时一并使用。首次新增挂载需要 compose up，单纯 restart 不会新增挂载。

在 NIfTI 首页导入生成的 JSON。清单预览会持久化到应用的 SQLite；打开病例时才保存原图和导入 mask。带 manifestId 和 caseId 的入口链接能在刷新后恢复完整列表。原始数据文件保持只读，编辑仍保存到应用独立原图库。

## 实体与交互

- Case：清单中的病例，以显式 caseId 标识，打开后记录 sourceId。
- Report：病例下的一个文本来源，可有多个；每个语句具有稳定 id。
- Finding：病例的影像发现，保留原始文本；引用 segmentation 文件，再由导入结果解析为持久 maskId。
- Label：一个分割文件中实际出现的整数标签。保留非连续值（例如 1、2、4），不按序号重命名。
- 既有分割组、目标和历史格式不变。此版是关联视图，不重新拆分或合并体素。

点击左侧 Finding 或 Label 可调用原有定位与闪烁；报告显示当前 Finding。原始文字相似匹配仅显示候选，点击“关联”才确认。链条按钮允许选择其他报告语句，已关联可取消。关联使用清单 revision 检查，冲突会刷新数据并提示重试。病例之间的语句不能串联。

“标注与 AI”完整保留画笔、AI、独立透明度、其他目标透明度、边界、保存、导出和历史面板。

## JSON 接口

顶层 `{ "cases": [...] }`。每例含 `caseId, name, modality, image, segmentations, reports, findings`。详见生成样本。reports 为 `{id, name, statements:[{id, section, text}]}`；findings 为 `{id, text, segmentations:[路径], candidateStatementIds:[语句ID]}`。

旧三列 CSV 继续可用。JSON 支持最多 256 份 segmentation；清单仍限制 5 MiB。输入中的候选不会自动提升为已确认关联。

服务端增加 `GET /nifti-images/manifests/{id}`、`PUT /nifti-images/manifests/{id}/binding`，沿用既有同源入口和存储卷。

## 当前边界

报告为只读；本次实现清单导入的 Finding—mask 关系及 Finding—报告语句确认。新建 Finding、手工重绑任意新 mask、报告编辑、跨病例关联，以及 DICOM 混合清单尚未实现。单独从“已保存病例”打开原图不猜测其属于哪个清单；查看报告请使用清单入口或带 manifestId 的链接。

## 验证

后端 test_manifest / test_workspace / test_groups / test_mask_history / test_mask_restore；前端 workspace / masksRecovery / presentation / maskLocation；浏览器脚本 `deploy/local/workspace-check.cjs` 验证真实 ReX 样本和 DICOM 检查列表。详细结果与截图保存在 local-data/acceptance。
