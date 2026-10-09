# OHIF-AI：NIfTI 原图加载与展示接入评估

调研日期：2026-09-15。范围是当前本地源码、现有 vanilla 部署记录、Cornerstone 匹配版本源码和官方接口文档。本轮未修改业务代码、依赖锁文件或线上服务；尚未完成浏览器 NIfTI 原图原型。

## 结论

推荐增加原生 NIfTI 数据源与加载适配层，继续使用现有 OHIF 布局、Cornerstone Stack/Volume viewport 和工具。先完成独立原图展示，再扩展当前 mask/nnInteractive 协议。不要把现有 NIfTI mask 接口改成原图接口，也不要为此整体升级 Cornerstone。

当前源码已经支持 **DICOM 原图上的 NIfTI 分割草稿**，并不支持 **以 NIfTI 作为独立原图**。这两个能力的数据类型、几何来源和持久化身份不同。

## 一、当前项目实际特点

| 层次 | 当前实现 | 对 NIfTI 接入的影响 |
| --- | --- | --- |
| Viewer | OHIF 3.10.4；`Viewers/extensions/*/package.json` | 通过 extension/data source/mode 扩展，无需另建看图站点 |
| 渲染 | `yarn.lock` 中 core、tools、dicom-image-loader 为 3.33.5 | 已有 Stack、MPR/Volume 机制；不能直接套用最新 4.x API |
| 依赖补丁 | `Viewers/patches/@cornerstonejs+tools+3.33.5.patch`，构建校验 | 维持 Stack labelmap actor 复用及内存回收，避免升级冲掉修复 |
| 原图入口 | Orthanc/DICOMweb；本地加载器默认 DICOM，另支持 PDF | `.nii/.nii.gz` 当前会落入错误的 DICOM 解析路径 |
| 工作台 | `/viewer` longitudinal mode，定制中文 UI 和 AI 面板 | 新数据源应保留工作台使用习惯，按数据源能力显隐操作 |
| mask | 多分割组、重叠、dirty/lineage、Save/Load All；NIfTI + JSON sidecar | 可复用 mask 生命周期与 UI，不能直接复用所有 DICOM 几何假设 |
| AI | stability-v1，单用户共享 nnInteractive session、lazy load、RLock | 首轮不要扩展为多用户并发，也不要重新启用已隔离的重模型 |
| AI 身份 | selected-mask v1 协议，SOP UID + 几何验证、revision/token | 原生 NIfTI 没有 DICOM SOP UID，必须增加受控的源类型分支 |
| 保存 | NIfTI 草稿与 DICOM-SEG/PACS 两条路径 | 原生 NIfTI 优先 NIfTI 导出；无真实 DICOM 引用时不能直接 Save to PACS |
| 部署 | Nginx/OHIF + Orthanc + MONAI，Tailscale HTTPS，现有持久卷 | 原图库需要单独存储和挂载，可复用同源鉴权入口 |

`SOURCE_PACKAGE.md` 是 8 月 12 日初始快照说明；判断当前行为还必须结合 8 月 26 日的 `STABILITY_V1.md`、`NNINTERACTIVE_MASK_EDIT.md` 和实际代码。

### 直接证据与改造落点

- `Viewers/platform/app/src/routes/Local/fileLoaderService.js`：除 PDF 外均调用 DICOM loader；`filesToStudies.js` 写入 `DicomMetadataStore`；`Local.tsx` 固定选择 `dicomlocal`。
- `Viewers/extensions/default/src/getDataSourcesModule.js`：只有 dicomweb、dicomwebproxy、dicomjson、dicomlocal、merge，没有 NIfTI 数据源。
- `Viewers/extensions/default/src/getSopClassHandlerModule.js`：生成 display set，依赖自然化 DICOM 字段、可重建性检查及实例排序。
- `Viewers/extensions/default/src/commandsModule.ts` 的 `prepareNiftiDraft`：按当前 DICOM imageIds 的 rows/columns/切片数验证 mask 长度。
- `monai-label/monailabel/endpoints/nifti_store.py` 的 `get_draft`：SimpleITK 读取后转为 uint8 mask，再以 multipart 返回，而不是提供原始 NIfTI 下载。这条路径不能承载 CT 的负值或 MR 浮点原图。
- `monai-label/monailabel/utils/others/source_image.py`：`read_source_dicom` 使用 GDCM DICOM 序列读取器；并非通用文件读取。
- `basic_infer.py`：自定义推理入口从 image 路径派生 DICOM 目录，读取实例并缓存。MONAI 框架一般支持医学图像文件，不意味着本项目定制入口能直接接受 `.nii`。
- `nnInteractiveController.ts` 的 `dicomSlice/capture` 和后端 `nn_context.py`：强制校验 SOP 引用与位置/方向/spacing，目前不能靠补一个随机 Series UID 绕过。

## 二、可行路线比较

| 路线 | 优势 | 代价/限制 | 建议 |
| --- | --- | --- | --- |
| 原生 NIfTI + Cornerstone 数据源 | 保留原始浮点、affine 和文件语义；复用现有看图工具 | 要适配 OHIF 元数据、loader 生命周期，AI 需后续扩展 | **主路线** |
| 后端 NIfTI 转派生 DICOM，再入 Orthanc | 较快接入现有检查列表和 DICOM 驱动工作流 | 需生成合规派生对象；浮点/缩放、原始 affine、身份和转换记录更复杂；仍需验证 AI 坐标 | 若强制立即复用 PACS 全流程，可作为独立兼容导入器 |
| 独立 NIfTI viewer（例如另一个 canvas/嵌入页） | 小范围看图可能更容易 | 工具状态、分割、坐标和导出需要两套维护 | 不作为本项目默认方案 |

转 DICOM 不等于“恢复原始 DICOM”：NIfTI 通常没有原扫描的患者、设备、协议和逐实例引用信息。不得编造原始扫描参数，也不能保证转换后现有流程无需验证。

## 三、匹配版本 loader 的实际审查结果

官方 npm 存在 `@cornerstonejs/nifti-volume-loader@3.33.5`，peer dependency 为 `@cornerstonejs/core ^3.33.5`，依赖 `nifti-reader-js ^0.6.8`。当前项目未安装该包。名称虽为 volume-loader，这一代 API 已采用 NIfTI imageIds，同时可支持 Stack 和 Volume。

已下载并检查发布包，位置：`.migration-vanilla/nifti-loader-3.33.5/`。以下仅针对 **3.33.5**，不声称最新版仍有同样问题。

1. **已复现：强度缩放条件错误。** `helpers/modalityScaleNifti.js` 仅在 slope 不为 1 **且** intercept 不为 0 时缩放。原值 100、slope=1、intercept=-1024 得到 100，应为 -924；slope=2、intercept=0 得到 100，应为 200。还应另外测试整数输出溢出、slope=0/未定义和大小端。
2. **已复现公式偏差：斜切且非等距体素。** `createNiftiImageIdsAndCacheMetadata.js` 的切片位置逐分量乘 spacing[x/y/z]；应取 affine 的第三列乘 k。示例 spacing=[1,1,5]、法向量=[0.5,0,0.866...]、k=10，x 应为 25，表达式算出 5。此验证执行提取的位置表达式，不是端到端渲染测试。
3. **本地压缩文件适配。** 元数据下载阶段以 URL pathname 的 `.gz` 后缀判断压缩；`blob:` URL 不保留文件后缀。因此本地 `.nii.gz` 需要按 magic bytes 解压/解析或受控重写，不能直接假设 object URL 可用。
4. **失败恢复。** 完整体数据采用 XHR，代码缺少充分的 HTTP status/onerror 处理；共享请求失败后，等待者轮询 `fetching` 状态的路径需要补全 reject、取消和清理。
5. **内存。** 私有 `dataFetchStateMap` 保存整卷 scalarData，同时创建每切片数组副本；元数据流的 appendData 也有累计复制。不能仅看 Cornerstone cache 统计。需把下载、解压、源体素、slice view、volume、mask 和 GPU 缓冲一并核算。
6. **元数据。** FrameOfReferenceUID 被写成固定值；独立 NIfTI 必须使用各自稳定的空间身份，不能因此被误判为已配准。PixelSpacing 排列、qform/sform、单位、斜切/剪切需独立测试。
7. **格式范围。**当前缩放函数列出有限 scalar 类型，FLOAT64/RGB/complex 不直接支持；元数据枚举沿 dimensions[2] 生成切片，不能据此宣称支持完整 4D 工作流。

最小验证：`node .migration-vanilla/probe-nifti-loader.cjs`。结果保存在 `nifti-loader-probe-result.json`。实际发布包的缩放函数被执行，cache 管理接口被 stub；未加载浏览器或 GPU。

结论：使用匹配版本作为基线，但需要项目级适配/修复和验收。可以沿用现有 patch-package 机制维护必要小补丁；复杂的文件读取、并发及内存控制更适合放入独立适配模块，避免继续扩大 `commandsModule.ts`。

## 四、推荐结构

```text
本地 File / vanilla NIfTI 原图库
        ↓
NiftiSourceService：身份、格式检查、读取、取消、释放
        ↓
Header + scalar buffer + voxel→LPS affine
        ↓
NIfTI image loader / metadata provider
        ↓
NIfTI data source + display set adapter
        ↓
现有 OHIF Viewer：Stack、窗宽窗位、测量、MPR
        ↓ 后续阶段
通用 SourceImage/Geometry 接口 → mask 与 nnInteractive
```

建议创建 `Viewers/extensions/nifti`，拥有 getDataSourcesModule、对应 display set handler、loader/metadata 注册和生命周期；新增受控入口 `/nifti` 或“打开 NIfTI”。具体独立 handler 与既有 handler 的分工先由小型集成原型验证，不直接假设一个 loader 注册调用能接通所有 OHIF 服务。

OHIF 内部仍使用自然化 DICOM 风格元数据。可以生成**仅供 Viewer 内部使用**的稳定 study/series/切片标识，并附 `sourceType: nifti`、`sourceId`、`geometryHash`。这些不是原始 DICOM 实例；不要通过这种适配绕过 DICOM-SEG 导出或 AI v1 的真实 SOP 校验。

`SourceDescriptor` 建议包括：sourceType、sourceId、displayName、contentHash、dimensions、dtype、scalar/component 信息、时间维、空间单位、原始 sform/qform 和 code、选定 affine、voxelToLPS、geometryHash、缩放参数、转换历史，以及 capabilities。文件名不能作为唯一身份；同尺寸不同体数据也不能共享 AI session 或 mask。

### 几何与强度约定

- 统一毫米 LPS 作为前后端物理空间。原始 voxel→RAS 矩阵左乘 `diag(-1,-1,1,1)` 得到 voxel→LPS；这一步坐标换基不意味着要翻转体素数组。
- 显式选择有效 sform/qform，记录采用哪一个。二者冲突需要提示或明确策略；没有可信物理空间时不得悄悄赋予正确解剖方向。
- NIfTI scalar 存储、JS IJK、SimpleITK numpy `[z,y,x]` 之间定义明确索引映射。显示时重采样/重排，必须保留到原始 voxel 网格的可逆映射或变换记录。
- 缩放只应用一次，避免 uint8 原图、错误截断和 CT HU 偏移。NIfTI 本身不保证是 CT/HU；缺少可靠 modality/unit 信息时采用通用强度窗，允许用户选择 CT/MR 显示预设。
- 斜切正交网格与包含 shear 的 affine 分开处理；首版拒绝 shear 或明确生成重采样派生体。mask 用 nearest-neighbor，原图插值策略单独设定。
- 每个独立 source 使用独立 FrameOfReference；相同尺寸、同一患者或文件名相似都不能证明已配准。

### 生命周期与远程性能

首版建议先本地完整载入，显示进度和内存预算，提供取消。压缩 NIfTI 通常不能靠普通 HTTP Range 随机读取任意解压后的切片；整体载入会减少逐片请求，但首屏仍可能等待较大的文件，不能承诺自动修复当前 Tailscale 中继瓶颈。

避免将本地文件先上传 vanilla，再下载回来才显示。本地看图无需上传；仅在用户选择持久化或 AI 时传至服务端。远程原图采用同源 `/monai/nifti-images/...` 或受控 Nginx 文件出口；大文件可由 Nginx 经授权后发送，避免在现有同步 AI event loop 内长时间处理解压/下载。`.nii.gz` 应避免不匹配的二次 gzip Content-Encoding。

按 sourceId 管理唯一源缓冲，slice 尽可能采用 view；引用计数覆盖多个 viewport。切换数据时取消请求/worker、释放 object URL、metadata、缓存及 loader 私有 Map。复用现有 memory ledger 思路，不假设其当前统计已包含新 loader 的所有缓冲。

## 五、分阶段实施与验收

### 阶段 A：独立原图本地展示（建议下一轮实施范围）

支持 NIfTI-1 单文件 3D scalar `.nii/.nii.gz`，明确覆盖 uint8/int16/uint16/float32 等经过测试的类型。支持 Stack 滚动、缩放、平移、窗宽窗位、方向标记、物理距离测量和有效正交网格的三平面 MPR。拒绝尚未支持的 4D、多分量、complex、shear 及损坏文件，给出可理解错误。

保留原有 DICOM 入口。NIfTI 源未通过后续适配前，AI、Save Draft/All、Load Drafts、Save to PACS 根据 capabilities 关闭并给出明确原因。不要留下可以点击但必然调用 DICOM 后端失败的按钮。

验收：非对称方向 phantom、负值 CT、float32 MR、slope/intercept 单独生效、非等距和斜切数据；与 NiBabel/SimpleITK 的参考几何及实际可用的外部 viewer 对照；同尺寸不同 source 切换；取消/失败重试；重复开关文件无持续内存增长；既有 DICOM 与 mask 操作回归。

### 阶段 B：vanilla 原图库与可分享访问

新增独立 `nifti_images` 存储卷；原文件不可变，metadata/index 与派生表示分开。建议 API（设计，不是现有端点）：`POST /nifti-images`、`GET /nifti-images`、`GET /nifti-images/{id}/metadata`、`GET /nifti-images/{id}/file.nii.gz`（依据实际存储扩展名返回）。UI 可从工作列表切换 DICOM/NIfTI 数据源，或先使用独立 NIfTI 列表。

按解压后的 dimensions×bytesPerVoxel 设预算，不能只限制压缩包体积；校验 magic、维度、dtype、affine、单位和数据完整性。沿用当前认证入口；不开放匿名任意文件路径或任意 URL 服务端抓取。新增路径以 sourceId 查受控记录。

### 阶段 C：原生 NIfTI mask 保存与 nnInteractive

将 `read_source_dicom` 上层抽象为按 sourceType 分派的原图解析器，DICOM 分支保持现状；NIfTI 分支读取已登记文件与一致的空间变换。前后端新增 context v2：sourceType/sourceId、geometryHash、shape/dtype、原始与显示/模型网格变换，同时保留 segmentationId、segmentIndex、revision、generation、requestId 和 sessionToken 的防过期机制。

旧 DICOM context v1 继续严格校验真实 SOP；NIfTI v2 校验内容身份、affine 和网格映射，不能通过放宽 v1 校验实现。同步 seed、提示点/框和结果的轴序，写回只作用于选中 mask。

新 NIfTI 原图的 mask 放到独立 sourceId 命名空间并带 sidecar 版本；原有 DICOM UID 下的草稿不迁移。保存后重新加载应保持空间、前景和 lineage。纯 NIfTI 无真实引用时使用 NIfTI 导出；PACS 需要另行验证派生 DICOM 原图与 DICOM-SEG 的成套导出。

### 后续扩展

4D/timepoint、NIfTI-2、RGB/vector、超大体数据分块、配准叠加及多用户隔离单独立项，避免在第一版一次性承诺。

## 六、工作边界与参考

本轮完成代码审查、匹配包核实、两项最小公式/函数验证和接入设计。没有运行 NIfTI 浏览器验收，也没有改动当前已可用的 vanilla 部署。最值得先做的是阶段 A 的最小端到端原型，用真实显示和几何测试验证上述适配设计，再决定原图库和 AI 扩展的投入。

- [OHIF 自定义数据源](https://docs.ohif.org/platform/extensions/modules/data-source/)：非 DICOM 数据可映射到 OHIF 内部元数据模型。
- [Cornerstone v3 NIfTI API](https://v3.cornerstonejs.org/docs/api/nifti-volume-loader/globals/) 与 [imageId/Stack 接入说明](https://v2.cornerstonejs.org/docs/migration-guides/2x/nifti-volume-loader/)：已有原生加载基础。
- [3.33.5 发布包元数据](https://registry.npmjs.org/@cornerstonejs/nifti-volume-loader/3.33.5)：本次核查的确切版本。
- [NiBabel NIfTI 文档](https://nipy.org/nibabel/nifti_images.html)：affine、sform/qform 和缩放参考。前后端需要选定一致策略，不把某一库的默认选择误当成所有软件都相同。
