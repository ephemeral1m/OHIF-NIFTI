# NIfTI Draft 修复状态（2026-08-11）

## 版本基线

- 分支：`local/nifti-drafts`
- 本地原始快照：`7a9b4f1`（`origin/local-original-snapshot`）
- 多草稿与第一阶段内存修复：`a095e13`
- 第二阶段 Stack labelmap actor 修复：本文件所在提交
- 上游参考：<https://github.com/CCI-Bonn/OHIF-AI>

## 当前已实现

### 多 NIfTI 草稿工作流

- 一个 NIfTI mask 对应一个独立 Segmentation 和一个实际 Segment。
- 多个 Segmentation 可同时显示，支持 overlap、inactive display 和 opacity。
- `Load All` 按当前存储库快照同步，具有 dirty 提示、原子提交和幂等语义。
- 单张 `Load Draft` 按 lineage 新增、激活或更新，不再受全局 active Segmentation 的 replace 判断干扰。
- `Save All` 遍历当前序列全部 NIfTI masks，按每张 mask 的哈希、名称和 dirty 状态分别保存并汇总结果。
- DICOM SEG、RTSTRUCT 和其他序列不参与 NIfTI reconcile。

### Label-only draft 兼容

- 几何有效但前景 voxel 为零的历史 NIfTI 被识别为合法 label-only draft。
- 空草稿仍创建独立 Segmentation，可激活并从空白开始绘制。
- 已有空 lineage 仅在受控条件下允许空保存；新建空 mask 和把非空 lineage 擦空后保存仍会拒绝。
- 旧 sidecar 缺少空 mask 字段时通过实际 NIfTI 内容兼容识别，无需迁移医生已有数据。

### 第一阶段内存止血

- multipart 解析和 NIfTI prepare 使用 buffer view，移除可避免的完整体素复制。
- dirty 检查采用无输出 buffer 的增量 hash；保存路径只分配一次最终 mask buffer。
- `Load All` 顺序暂存，不在暂存阶段注册 UI、representation、VTK actor 或 nnInteractive session。
- 增加 derived image/volume 的统一回收路径和可达 buffer ledger。
- 重复干净 `Load All` 不增加 Segmentation、representation 或 cache bytes。

### 第二阶段 Stack labelmap actor 修复

- 固定 `@cornerstonejs/tools` 为 `3.33.5`，通过 `patch-package` 应用项目级补丁。
- Stack viewport 切片变化时复用 actor 和单切片 scalar buffer，不再执行逐切片 `new constructor(newPixelData)`。
- 一次切片事件只执行最终 render，并补充 Stack actor/mapper/imageData 的幂等释放。
- 删除 representation 时处理该 Segmentation 的全部 actor entry，并保护 Volume viewport 路径。
- Docker 构建会强制校验补丁；版本不符、补丁缺失或旧复制表达式恢复时直接失败。
- `_debugNiftiDraftMemory()` 可报告当前 cache、actor UID/referencedId、scalar bytes 和去重后的已知 buffer roots。
- 详细 ledger 日志生产环境默认关闭，可通过 `_setNiftiMemoryDebugLogging(true)` 显式开启。

## 2026-08-11 实测结果

### 5 masks / 283 slices

- NIfTI derived labelmaps：353.75 MiB
- CT source images：141.50 MiB
- actor scalar buffers：2.50 MiB
- 已知 buffer union：497.75 MiB
- Firefox OHIF content PSS：约 870 MiB

### 6 masks / 349 slices，多次全栈滚动并切换病例后

- NIfTI derived labelmaps：523.50 MiB
- CT source images：174.50 MiB
- actor scalar buffers：3.00 MiB
- 已知 buffer union：701.00 MiB
- Firefox OHIF content PSS：约 1.11 GiB
- 相比上一病例，已知数据增加 203.25 MiB，content PSS 增加约 266 MiB；额外差值约 62.8 MiB。
- 旧病例的 derived images 未保留在当前 cache roots 中。
- 多轮滚动未出现按 `Segmentation × 已浏览切片` 累计的 actor scalar buffer。

## 当前已知限制

- Stack viewport 当前每个 NIfTI Segmentation 固定存在两个指向同一当前切片的 actor，而理想状态为一个。该数量不会随滚动增长；6 masks 病例的额外 scalar 常驻量约 1.5 MiB，但可能产生少量重复渲染，后续应单独清理。
- label-only draft 本阶段仍使用 dense labelmap；空 mask 的常驻成本与同尺寸非空 mask 相同。RLE 或 active-only dense 不在本轮范围内。
- Firefox jemalloc/图形进程可能保留历史高水位，切换病例后不一定立即把 PSS 归还操作系统；当前 cache roots 和 active actor buffers 已能正确释放/对账。
- 本轮未调整 Cornerstone 3 GiB cache 上限，也未改变 NIfTI、sidecar、REST API 或 MONAI 后端格式。

## 构建与运行

```bash
bash start.sh viewer
```

构建必须出现：

```text
[Cornerstone stack labelmap patch] verified @cornerstonejs/tools 3.33.5
```

浏览器诊断：

```js
JSON.stringify(window._debugNiftiDraftMemory(), null, 2)
```

本次交付镜像标签与导出文件记录在交付结果中。
