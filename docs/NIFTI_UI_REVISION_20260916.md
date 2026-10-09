# NIfTI 检查列表、服务器清单与插值修复（2026-09-16）

## 交付变化

- DICOM 首页只保留一个 NIfTI 入口，使用专门绘制的文件/体积 SVG 图标。
- `/nifti` 使用 OHIF 页头及检查列表布局，包含原图库、CSV/JSON 病例、搜索、分页、逐行错误与图标操作。
- 清单支持原图和最多两个分割文件。vanilla 的 CT-RATE 根目录为
  `/data/cache/datasets/CT-RATE`，仅只读挂载。预览不读取体素，打开时执行原有格式、空间及大小验证。
- 工作台复用既有 AI Toolbox、Segmentation Tools 和分割组面板；新增/导入/保存/加载/导出采用图标。
- 修复 PanelSection.Header 未转发点击事件，分割组标题现在确实选择编辑目标。
- 新增工具栏 section 替换接口，避免追加遗留 DICOM 保存按钮。
- 本地原图点击 AI 工具时先上传，成功后启用工具；保存、刷新、目标隔离继续沿用原生 source/context v2。
- Interpolate 等待异步结果后更新视图；3.33.5 ITK pipeline 随站点提供，Worker 错误传回通知。
  原报告中的间歇性网络条件未完整重现，不将外部 CDN 判定为唯一历史原因。

## 本次实际验证

隔离环境：vanilla HTTPS 9444，GPU 1，独立 Orthanc、原图与 mask 卷。
浏览器：本机 Windows Edge 153.0.4234.32，1500×950，headless，Core Ultra 9 275HX。

| 检查 | 结果 |
| --- | --- |
| 后端原生与 DICOM v1 稳定性 pytest | 123 passed，含 9 个新清单测试 |
| ToolbarService Jest | 2 passed，覆盖替换时移除旧按钮 |
| 生产模式构建、离线 frozen-lockfile 安装及 Stack 补丁校验 | 通过；Cornerstone 保持 3.33.5 |
| ui-manifest | 单入口/SVG、CSV/JSON、无效路径禁用、自动加载两个标签、真实组标题切换和画笔通过 |
| 目标隔离 | 标签 300 由 729 变为 2564 体素；标签 900 哈希保持不变 |
| CT-RATE | valid_668_b_2，512×512×192 int16，96 MiB；Stack/MPR 通过 |
| ui-ai | 实际 Points 图标先上传；GPU 推理 489674 前景体素，Save All/刷新重载 SHA-256 一致 |
| workflow | 画笔与多标签共 3 组保存、ZIP 导出、刷新后逐体素一致；MPR 坐标误差 0 mm |
| DICOM Interpolate 实际按钮 | 第 10、20 层共 800 种子体素 → 11 层共 4400 体素；第 15 层非空 |
| 插值运行时网络 | 只请求站点内的 interpolation WASM/JS；无外部 CDN 请求 |
| memory | 打开/关闭 10 轮，私有源/切片缓存与旧源可达字节均为 0 |
| 128 MiB 完全载入后滚动 | 50 次切片切换，0 网络请求；p95 4.9 ms（本机测试值） |

上述新版浏览器场景均没有运行时错误；DICOM 的既有 Shepherd 引导警告单独记录。
9 月 15 日的完整格式、几何、PACS 与双浏览器证据属于上一版本，保留在旧归档，
不作为本次所有场景均重新执行的声明。当前修订主要验收使用 Edge。
性能结果不含下载耗时，也不代表解决了 Tailscale/VPN 中继瓶颈。

## 发布与回退

以下镜像已成套发布至正式 HTTPS 9443，后端 healthy，Nginx 语法检查通过：

- Viewer: `sha256:653e79d7377f735ae3b8d1e0de91664945fdbe55bf373e5ad9bac2c4092d2edd`
- Backend: `sha256:b2f4fa5436c5b8531418d9b2dd29d0edde1e855e588905ad80e6204f6cf19b77`

`deploy/nifti/release-ui.py` 在 vanilla 的
`/home/ubuntu/ohif-ai/deploy/nifti-ui-release-20260916` 保存上一对原生镜像及 Nginx 配置。
正式环境仅增加 CT-RATE 只读根目录，测试 fixture 根目录不进入正式配置。
回退执行 `python3 deploy/nifti/release-ui.py rollback`，不删除原图、mask、DICOM 草稿或数据卷。

正式只读冒烟通过：未认证请求 401；健康、原图库及 DICOM 查询成功；
原有 4 个 DICOM 检查和 2 个 NIfTI 原图保持不变；单一入口、专属主页与
CT-RATE 清单预览通过。未将测试 mask 复制到正式环境。

发布记录及检查证据保存在 `release-artifacts/nifti-ui-20260916` 的 `release.json` 和
`production-ui.json`。使用说明见 `NIFTI_USER_GUIDE.md`；清单范例见
`deploy/nifti/examples/ct-rate.csv` 和 `ct-rate.json`。
