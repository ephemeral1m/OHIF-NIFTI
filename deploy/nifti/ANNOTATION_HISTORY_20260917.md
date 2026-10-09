# 独立标注轨迹第一版

每条轨迹以 sourceId + maskId 标识，名字改变不会拆开轨迹。顶部选择标注，
下面只呈现它自己的版本。四份以内用颜色/名称按钮，更多用名称搜索和下拉选择。
选中记录、当前编辑、最新保存三个状态分别展示。旧记录没有操作分类时使用“首次保存/修订保存”，
不猜测其操作由画笔或 AI 完成。

## 三种操作

预览：独立只读 canvas 使用原图共享缓冲和已校验、对齐的历史二值 mask。
按当前 viewport 的强度范围显示原始切片；不会注册 Cornerstone segmentation，
不会改变当前编辑目标或参与 Save All/AI。它是原始切片预览，不提供 MPR 编辑和测量工具。
预算计入解压、工作缓冲、对齐输出、RGBA 切片和画布。取消/切换/关闭释放预览所有权。

恢复：同一 maskId 追加版本，record.operation=restore、restoredFrom、parentVersion。
历史文件逐字节复制到新版本目录，当前名称保留，颜色取所选版本。
首先下载校验并预留浏览器目标内存，再提交服务器；本地替换使用新的 runtime segmentationId，
旧目标仅在新目标完整可用且未产生新修改时删除，避免旧 AI 响应应用到恢复后的目标。
如果服务端已提交但本地无法更新，明确报告新版本号并保留原编辑，不伪装成整体回滚。

独立副本：仅显式操作时产生新标注，使用区别于已加载目标的颜色；Save All 后有自己的轨迹，
derivedFrom 链接到原标注及版本。打开来源时沿原标注分页找到该版本。

## 接口和一致性

- GET `/nifti-images/{sourceId}/masks/history?maskId=...&offset=...&limit=...`：
  服务端按身份过滤再分页，total 也是这份标注的总版本数。旧的全病例查询继续兼容。
- POST `/nifti-images/{sourceId}/masks/{maskId}/restore`：
  JSON `{version, expectedVersion, requestId}`；只允许受控身份查找。
  写操作锁 + SQLite BEGIN IMMEDIATE；旧版本不可变，临时文件 fsync 后原子提交。
  expectedVersion 变更返回 409；相同 requestId 重试返回原结果，不能重复生成版本。
  新增 mask_restores 表记录重试身份，不修改旧 DICOM 草稿和既有 masks 表结构。
- 前端目标 dirty 时禁止恢复/替换。并发的迟到编辑也会在替换前再次检查并保留。

## 验证与发布

- 后端格式/存储/stability_v1/独立分页/恢复/重复请求/冲突/落盘失败回滚测试。
- Jest 验证独立只读缓冲、旧编辑保护、同身份恢复，以及既有加载恢复场景。
- `annotation-history-acceptance.cjs` 在 9444 用独立合成病例测试：轨迹隔离、只读预览、
  切片、取消、dirty 保护、保存后恢复、MPR 表示、来源跳转、显式副本、窗口缩放、病例关闭释放。
- 本轮结果：pytest 130 项、Jest 9 项通过；隔离环境的独立轨迹、阶段一 UI 和内存回归通过。
  十轮病例开关后原图和私有缓存计数归零；128 MiB 体完全载入后滚动 50 次无网络请求，
  本机 headless Edge 测得 p95 4.6 ms（不代表远程首屏速度）。DICOM interpolate 本轮未重新执行；
  本轮未修改 DICOM 功能代码。
- 发布脚本 `release-annotation-history.py prepare/activate/rollback`。
  成套镜像记录在 `/home/ubuntu/ohif-ai/deploy/nifti-annotation-history-release-20260917`。
  紧邻上一版的临时 OCI 标签被替换后，其 manifest 已不可用，也无法提交运行中容器。
  本次回退基线因此选用仍完整保留的 `phase1-20260916` 前后端配对镜像，两者均通过启动检查。
  这不是紧邻上一版的精确快照；回退会暂时停用新版历史界面，保留原图、新版本和副本文件。
  新版镜像已使用独立的 `annotation-history-20260917` 标签固定，避免再次随测试标签丢失。
- 9443 正式发布后只读验证通过：ReX 病例 7 份标注可独立选择，所选轨迹 2 个版本，
  第 77 张切片可预览病灶，关闭后内存回到预览前；未注册编辑目标，也没有标注写请求。
  首页/设置/CSV 列表正常；原图库 5 例、DICOM 4 例和原有只读目录保持不变，匿名请求返回 401。

本次未实现工作区整体快照、每笔操作记录、分支/合并、外部数据集文件覆盖。
