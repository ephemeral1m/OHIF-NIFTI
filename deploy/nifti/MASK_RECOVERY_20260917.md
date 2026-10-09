# Mask 加载恢复与简单版本窗口

## 已实现

- 复现线上 ReX 第一例已有 7 个 mask 时的重复点击无反馈。此前已加载身份被静默跳过。
  新窗口明确显示已加载版本；批量加载汇报新增、已有、失败数量，不覆盖当前编辑。
- 导入临时预算从固定 1 GiB 改为 Worker 读取头后申请实际 compressed file + header +
  raw + working buffers + 16 MiB 开销，主线程确认预算后才允许大块分配。
  原图加载的既有 512 MiB 限制及默认 1.5 GiB 工作集预算保持不变。
- mask 下载流计入内存预算，显示下载/解压/对齐进度；连续 90 秒没有网络进展会停止。
  Worker 有 5 分钟执行上限；面板操作有 10 分钟截止时间；取消与病例切换释放临时预算。
- 每个文件独立返回成功/失败，重试仅补充未加载目标。已有目标、未保存编辑不被回滚。
- 新增只读分页 GET `/nifti-images/{sourceId}/masks/history`，返回既有不可变版本及
  `latestVersion`，沿用同源鉴权与受控身份查找。
- 版本窗口按保存时间排列。历史版本以独立副本加载，后续 Save All 创建新 maskId，
  sidecar 保存 `derivedFrom: {maskId, version}`；后端校验来源版本属于同一 source。
- 不覆盖 CSV 中的文件，不改 DICOM 草稿语义，不迁移当前全局 source 存储。

## 验证

- Node 格式/颜色 11 项通过；Jest NIfTI 内存及恢复 6 项通过。
- pytest NIfTI + stability_v1：127 项通过，两个既有测试依赖弃用提示。
- 隔离 Edge 实际 UI：加载最新、重复点击不重复下载、旧版本副本、保存 lineage、
  删除后 MPR 重载、空草稿、单文件 503 后重试、卡住下载取消并重试均通过。
- 同一浏览器场景在 64 MiB 预算下成功加载；压低至 1 MiB 后拒绝新增并保留原目标，
  恢复预算后重试可用。此前固定 1 GiB 预留无法通过这一场景。
- CSV 自动加载、改色保存/重载、MPR 同色、设置菜单和高 DPI 对话框回归通过。
  修复验收脚本误匹配已有同名病例按钮的等待条件，未因此修改应用逻辑。
- 10 轮打开/关闭后来源、影像、预算、可达旧缓冲和色表均归零；128 MiB 体数据滚动
  50 次无网络请求，测试机 p95 4.7 ms（合成数据、无头 Edge，不代表远程首屏时间）。
- DICOM interpolate 实际按钮回归通过：11 层共 4400 个前景体素，WASM/JS 同源加载。

## 下一步的最小设计（尚未实现）

1. 工作区与 manifest 最小模型：workspaceId、caseId、sourceId、setId、channelId、
   maskId/version，预留 reportId/findingId。CSV 是导入入口，不能作为不断改写的数据库。
   同一原图可以进入不同工作区，编辑归属必须由 workspace/case 明确隔离。
2. 右侧面板以 Set → Channel 重做；每个 channel 指向真实二值 mask 身份；展示来源、
   当前版本、未保存状态。左侧保留整个 manifest，报告作为病例子项。
3. 简单线性病例快照：显式“保存病例状态”记录当时的成员集合、每项 maskId/version、
   报告/finding 引用和名称/颜色等版本化显示信息。删除目标也必须记录成员变化。
   快照引用不可变文件，不再次复制全部体素。部分保存失败不宣称快照完整。
4. 恢复快照先暂存并验证全部目标，成功后切换，失败保留当前状态；恢复后再保存生成
   新快照。第一版无分支/合并，不追踪每一笔，不把按时间查询单个 mask 版本冒充病例快照。

## “保存原始 mask”的边界

日常保存：更新同一个应用内 maskId 的最新版本，旧文件不可变，可回看。这已经可用。
外部覆盖：另设“导出到原路径”，将来只对工作区允许写入的输出目录开放，显示目标路径、
检测文件是否被外部更改、保留备份并原子替换。数据集引用继续只读。
ReX CSV 的一份多标签文件在应用中会拆为多个独立 mask；不能把一个二值 channel
直接写回整份源文件。多标签重组须验证几何和重叠；原始 4D ReX 容器不属于首版回写范围。

## 发布与回退

先在 9444 验收，再用 `release-mask-history.py prepare/activate` 成套发布前后端。
快照目录 `/home/ubuntu/ohif-ai/deploy/nifti-mask-history-release-20260917`。
`python3 deploy/nifti/release-mask-history.py rollback` 恢复前一镜像对；不删除原图、旧版、
新增副本或 sidecar。旧前端不使用新增的可选 lineage 字段，现有文件格式保持兼容。
