# 当前代码与运行状态 — 2026-10-09

## 快照定位

本次整理的是 `E:\ohif-ai` 的完整可版本管理源码，不是仅本轮 UI 差异。此前目录来自无 Git 历史的源码包；原始基线记录在 `SOURCE_PACKAGE.md`。不包含运行数据、模型、依赖安装目录或部署认证材料。

当前开发入口为本机 Docker Desktop：`http://127.0.0.1:1026/nifti`，已通过 Tailscale HTTPS 9443 发布。前端挂载源码，后端挂载 Python 代码；原图库、mask、stream 缓存与 Orthanc 位于独立 Docker volumes。最新 UI 修复在本机生效，本次整理没有重新部署或验证 vanilla。

## 已实现的主线

### 2026-10-10 更新

- 修复原地切换病例后再次进入 Axial Primary 的 protocol 错误，清理已释放病例的布局缓存。
- 默认使用顶栏“浏览”；AI、画笔等工具再次点击退出，切换病例恢复浏览。切换工具类别不自动激活标注。
- NIfTI、DICOM 列表与查看器统一深色紫青配色，品牌采用单行纯文字 `OHIF-AI - Experimental`。
- NIfTI 清单增加报告、Finding、分割文件数量，保留文件展开、路径说明及现有导入流程。
- 相关 Jest 与独立 Edge 浏览器检查结果见 `NIFTI_ACCEPTANCE.md`；未重新进行 GPU/PACS 完整验收。

| 模块 | 当前状态 |
| --- | --- |
| 原图 | 原生 NIfTI-1 三维 scalar，本地与服务器加载，明确的身份与 LPS 几何，512 MiB 工作数据限制 |
| 网络加载 | 独立切片 gzip 缓存、当前层和邻近 ±8 层，完整体功能主动补齐；保留本地完整解析 |
| 原图库 | 文件与 SQLite 索引，受控路径导入、清单持久化、原图与 mask 独立存储 |
| 标注 | 二值 mask、多标签拆分、重叠目标、独立显示参数、历史版本及导出 |
| AI | nnInteractive v2 原生源身份和网格映射；种子同步、目标隔离、过期响应保护 |
| 报告工作台 | Case、Report、Finding 与 mask 引用；报告语句关联、病例树和原地病例切换 |
| 交互 | 顶部可折叠工具面板、AI/手工模式、MPR 画笔、专用提示光标、Crosshairs 再次点击关闭 |

Manifest 首版实现以 NIfTI 为主；DICOM 仍走原检查列表，尚未统一为混合 DICOM/NIfTI manifest。报告与 Finding 是关联视图，未实现完整报告编辑器、自动报告结构化或复杂的分支合并历史。

## 本阶段修复

- MPR 工具组补齐画笔、橡皮擦、阈值和形状工具；复用单层配置。
- 修复 toolbar 重复点击积累旧参数命令；延迟球形工具加载不能覆盖后来选择的工具。
- Axial Primary 首次进入能准备完整原图；多格布局保留原图与全部 mask。
- 修复 Stack/MPR mask actor、透明度与边界相关问题；补充内容哈希核验。
- 分割组标题优先使用 manifest Finding 原文；黑紫色菜单和工具卡统一风格。
- 标注工具置顶、折叠保留状态；补齐 AI 提示工具光标注册，默认启用工具光标。
- Crosshairs 再次点击关闭并恢复之前的工具，选择 Points/画笔也会退出。

## 验证记录与边界

本次归档没有把所有历史验收重新运行一遍。以下是本阶段已有的明确证据：

- 本地初始环境：合成 CT/MR、按层加载、画笔、真实 GPU nnInteractive、保存与历史重载、DICOM 浏览和热更新；见 `deploy/local/README.md`。
- 报告与病例切换：ReX 五例样本，说明见 `deploy/datasets/rexgroundingct/WORKSPACE.md`。
- 布局回归：首次 Axial Primary、1×1/1×2/2×2/2×3、自定义网格；原图加六份 mask 均保留。
- 工具回归：在十四份 mask 的病例上，Stack 与 MPR 三视窗共 36 次工具选择；三个平面实际绘制均只修改当前 mask，其他十三份 mask 的 SHA-256 保持不变。
- nnInteractive controller/edit/argument 三套 Jest：41 项通过，包括原生 v2 和 MPR 提示顺序。
- 最近控件回归：工具置顶、折叠恢复、光标 SVG 解码、三视窗光标继承、Crosshairs 开关与工具恢复通过，无页面异常。

完整过程见 `NIFTI_ACCEPTANCE.md`。原始本机浏览器结果和截图位于被忽略的 `local-data/acceptance/`；相关复测脚本保留在 `deploy/local/`。部分脚本仍引用本机运行时路径和测试 source/manifest ID，换机器需调整或重新 seed。

最近 UI 修复没有重跑真实 GPU 推理、全套 DICOM/PACS 或大数据性能验收。开发构建仍有既存的 webpack 循环 chunk 与 watch 模式 InjectManifest 警告。

## 已知数据问题与后续工作

- `valid_254_a_2` 的原始 ReX finding 0/1/2 本身存在完全相同的区域；13 个目标只有 7 个不同二值区域。不要将其自动去重，否则会丢失独立 Finding 关联。
- 继续完善 Finding 与目标的关联表达，以及报告/文件树长文本与较窄屏幕交互。
- 完整“工作区”及 Git 式标注分支、原始 mask 覆写不是已交付能力；当前保存进入应用版本化存储，不覆盖导入原文件。
- 后续发布前应在隔离环境再跑配套 GPU、DICOM/PACS、保存重载、十轮内存回收与低带宽性能验收。
- 新机器需准备镜像、GPU 运行时和权重；本仓库包含锁文件与 Cornerstone 项目补丁，不包含离线依赖。

## 继续开发

从 `deploy/local/Start-Local.ps1` 启动。前端热更新；后端修改后执行 `Start-Local.ps1 backend`。数据准备、Tailscale 发布、逐项浏览器复测脚本均位于 `deploy/`。停止服务应使用 `stop`，不要使用删除数据卷的命令。

此次源码发布将旧硬编码认证值移至忽略的本机 `.env`，实际 Orthanc 配置保留为忽略文件，仓库提交 `.env.example` 和 `orthanc.example.json`。影像、权重、测试输出和机器专属挂载配置也不纳入提交。
