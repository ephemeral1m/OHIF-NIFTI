# OHIF-AI 使用说明书

医学影像 AI 标注平台：OHIF Viewer + Orthanc PACS + MONAI-Label 后端 (集成 VoxTell / nnInteractive / SAM2 / MedGemma)。

---

## 一、系统启动

```bash
cd /home/ant/projects/OHIF-AI
docker compose up -d
```

三个容器服务：

| 服务 | 端口 | 作用 |
|---|---|---|
| `orthanc` | 4242 (DICOM), 8042 (Web) | DICOM PACS 存储 |
| `ohif_orthanc` | 3000 | OHIF Viewer 前端 (nginx) |
| `monai_sam2` | 8000 | MONAI-Label 推理后端 (GPU) |

**Orthanc 登录:** 用户名 `ohif` / 密码 `<YOUR_DICOMWEB_PASSWORD>`
**OHIF 访问:** http://localhost:3000

**注意:**
- 启动前需确保 NVIDIA 驱动正常 (`nvidia-smi` 能运行)。如遇 `Driver/library version mismatch`，需 `sudo reboot`。
- MedGemma 默认关闭，需要时设 `ENABLE_MEDGEMMA=1` 启用 (占用大量显存)。

---

## 二、AI 工具栏功能

OHIF Viewer 左侧 AI 工具栏 (aiToolBoxSection)，按使用顺序：

### 输入工具

| 按钮 | 用途 |
|---|---|
| `Probe2` | 单点正样本提示 (绿色) |
| `PlanarFreehandROI2` | 自由曲线 ROI 提示 |
| `PlanarFreehandROI3` | 负样本曲线 (排除区域) |
| `RectangleROI2` | 矩形框 ROI 提示 |

### 推理工具

| 按钮 | 用途 |
|---|---|
| `nninter` | nnInteractive 推理 (交互式精修) |
| `(textPromptSegmentation)` | VoxTell 文本提示分割 (右侧面板) |

### 输出工具

| 按钮 | 标签 | 用途 |
|---|---|---|
| `saveToPACS` | Save to PACS | 发布为 DICOM-SEG 到 Orthanc PACS |
| `saveToNifti` | **Save All** | **检查并保存所有已修改的 segment 为 NIfTI 草稿** |
| `saveDraft` | Save Draft | 保存当前活跃的单个 segment 为 NIfTI 草稿 |
| `loadDrafts` | Load Drafts | 加载该 series 的全部 NIfTI 草稿 |

---

## 三、典型工作流程

### 流程 A: 从批量报告 pipeline 加载 + 精修 + 保存

```
1. 后端 batch_voxtell_pipeline 处理报告 → 自动保存草稿到 /code/nifti_segs/<series>/
2. OHIF 加载 → 点击 [Load Drafts] → 选择 "all" → 全部草稿加载到 panel
3. 选中要精修的 segment (例: "右肺上叶后段...")
4. 选择 nninter 工具，点击或勾画提示 → 模型推理
   - 第一次精修时 label 自动追加 " (edited)"
   - draftOrigin 自动继承自原 segment
5. 多次点击直到满意 (期间不会自动写入磁盘)
6. 点击 [Save Draft] → 保存当前 segment 为新 NIfTI 草稿
   - 文件名: nninteractive_<label>_<timestamp>.nii.gz
   - sidecar 包含 "origin" 字段指向原始草稿
7. (可选) 点击 [Save to PACS] → 发布为 DICOM-SEG
```

### 流程 B: VoxTell 手动文本提示

```
1. 切换右侧 textPromptSegmentation 面板
2. 输入英文文本提示 (例: "left lung", "liver mass")
3. 选择 viewport 中的目标 → 推理
4. 自动生成 segment + 自动保存为 voxtell 草稿
```

### 流程 C: 从零开始用 nnInteractive 创建新 segment

```
1. 工具栏上的 "Refine New" / "Locked" 等切换 (toolboxState):
   - refineNew=true → 每次推理创建新 segment
   - refineNew=false → 精修现有 segment
2. 选择 nninter，点击提示
3. 这种 segment 无 draftOrigin (是新创建的)
4. [Save All] 会将其作为"新 mask"保存
```

---

## 四、Save Draft vs Save All 区别

| | **Save Draft** | **Save All** |
|---|---|---|
| **目标** | 单个 segment | 所有 segment |
| **触发条件** | 必须有 `draftOrigin` (精修中的 segment) | 任何 segment |
| **保存范围** | 仅当前活跃 segment | 全部已修改的 segment |
| **未修改的草稿** | N/A | 自动跳过 (不重复存盘) |
| **使用场景** | "我精修这个 segment 满意了，单独保存" | "批量整理，把所有改动保存到磁盘" |

**Save All 的判断逻辑:**

每个 segment 分三类：
- **refined** (有 origin + label 含 "(edited)") → 保存为精修版，覆盖同 origin 的旧版
- **new** (无 origin，用户新建) → 保存为新草稿
- **unmodified** (有 origin，无 "(edited)") → 跳过

通知示例: `Saved: 2 refined, 1 new, 5 unmodified skipped`

---

## 五、NIfTI 草稿存储 (`/code/nifti_segs/`)

### 目录结构

```
/code/nifti_segs/                          # 容器内路径 (host: ./monai-label/nifti_segs/)
├── <SeriesInstanceUID>/                   # 每个 series 一个目录
│   ├── voxtell_<label>_<timestamp>.nii.gz   # VoxTell 手动文本提示产生
│   ├── voxtell_<label>_<timestamp>.json
│   ├── merged_<label>_<timestamp>.nii.gz    # 批量报告 pipeline 产生
│   ├── merged_<label>_<timestamp>.json
│   ├── nninteractive_<label>_<timestamp>.nii.gz   # 精修后保存
│   └── nninteractive_<label>_<timestamp>.json
```

### Sidecar JSON 格式

**原始草稿 (voxtell / batch_report):**
```json
{
  "algorithm": "voxtell",
  "label": "Liver",
  "created": "2026-05-22T06:41:13",
  "segments": { "1": "Liver" },
  "status": "draft",
  "flipped": false
}
```

**精修草稿 (nninteractive，包含谱系):**
```json
{
  "algorithm": "nninteractive",
  "label": "Liver (edited)",
  "created": "2026-05-26T14:27:51",
  "segments": { "1": "Liver (edited)" },
  "status": "draft",
  "flipped": true,
  "origin": "voxtell_Liver_20260522064113.nii.gz"   ← 谱系追踪
}
```

### 字段说明

| 字段 | 含义 |
|---|---|
| `algorithm` | 来源算法: `voxtell` / `batch_report` / `nninteractive` / `sam2` / `body_seg` |
| `label` | 人类可读标签；精修版会追加 " (edited)" |
| `origin` | (仅精修版) 指向原始草稿的文件名 — **星形拓扑** |
| `flipped` | OHIF imageId 顺序是否反转 (DICOM IPP 降序) |
| `status` | `draft` (草稿) / `edited` (Save NIfTI 历史快照) |
| `segments` | segment 索引 → 标签 (单 segment 草稿固定为 `{"1": label}`) |

---

## 六、NIfTI 草稿保存与维护逻辑详解

### 6.1 星形拓扑 (Star Topology)

所有精修版本指向同一个原始草稿:

```
                voxtell_Liver_20260522.nii.gz   (原始)
                          ▲
                          │ origin =
       ┌──────────────────┼──────────────────┐
       │                  │                  │
  nninteractive_       (覆盖前一版本)        ...
  Liver (edited)_
  20260526.nii.gz
```

**为什么是星形而不是链表？**
- 链表 (origin → 前一版精修) 会让谱系复杂化、磁盘膨胀
- 星形拓扑保证：**每个原始草稿在磁盘上最多有一个精修版本** (永远是最新的)
- 重新加载时，refined 直接替换 original 在 panel 中的位置

### 6.2 保存路径 (后端)

`POST /monai/nifti-segs/{series_uid}` 处理逻辑 (`nifti_store.py`):

```python
# 1. 文件名清理 (防止换行符、特殊字符破坏文件系统)
base_name = f"{algorithm}_{_sanitize_for_filename(label)}_{timestamp}"

# 2. 如果带 origin，先删除同 origin 的旧版精修
if origin:
    for fname in os.listdir(d):
        sc = _read_sidecar(...)
        if sc.get("origin") == origin:
            os.remove(old_nii); os.remove(old_json)  # 只保留最新

# 3. raw_binary=True 时，从 DICOM 几何信息重建 NIfTI
if is_raw_binary:
    ref_sitk = sitk.ImageSeriesReader(...).Execute()
    seg_sitk = sitk.GetImageFromArray(seg_np)
    seg_sitk.CopyInformation(ref_sitk)  # 复制 spacing / origin / direction
    sitk.WriteImage(seg_sitk, nifti_path)

# 4. 写 sidecar JSON
sidecar = {algorithm, label, created, segments, status, flipped}
if origin: sidecar["origin"] = origin
```

### 6.3 加载路径 (`Load Drafts` 行为)

```
1. GET /monai/nifti-segs/<series_uid>          → 列出全部草稿
2. 前端 showDraftsList:
   - 过滤掉 source="ohif_save_nifti" 的快照
   - 排序: originals (无 origin) 在前，refined (有 origin) 在后
3. 用户选择单个或 "all":
   - 单个: 直接加载
   - "all": 顺序加载所有 (前端逐个 GET + 流式还原)
4. 每个 draft 流程:
   GET /monai/nifti-segs/<series_uid>/<filename>
   → multipart 响应: meta (含 origin) + uint8 mask 数据
5. loadNiftiDraft 关键逻辑:
   - 如果 draft 带 origin，在当前 panel 中查找匹配的 segment
     - 找到 → replacingOriginal=true，复用其 segmentIndex，清除旧 voxel
     - 找不到 → 创建新 segment
   - 这样保证：refined 加载后会"替换"原 segment，不会出现 NaN
   - draftOrigin 存入 cachedStats，作为后续精修的谱系锚点
```

### 6.4 精修流程中的不变量

**关键设计：refined 与 original 共享 segmentIndex**

为什么重要？因为 OHIF 的 labelmap 是 **shared** 的 — 每个 voxel 只属于一个 segment。如果 refined 和 original 共存于同一个 segment slot，它们的 voxel 会互相覆盖。

解决方法：
- 加载 refined 时检测 `origin` 匹配 → 复用同一个 segmentIndex
- 写入前先清除该 segmentIndex 的所有旧 voxel
- 这样 panel 显示永远是"最新"版本

### 6.5 边界情况

| 情况 | 处理 |
|---|---|
| 用户加载所有草稿，但某个 original 已被精修过 | refined 加载时找到 original 的 segmentIndex，替换之 |
| 用户连续点 nnInteractive 10 次精修 | 内存中刷新，**不**自动存盘；点 Save Draft 才生成单个文件 |
| 同一 origin 多次 Save Draft | 后端自动删除旧版，只保留最新 |
| 标签含换行符 (中文报告常见) | `_sanitize_for_filename` 替换为下划线 |
| 用户用 nnInteractive 凭空创建新 segment (无 origin) | Save All 视为 "new"，保存为新草稿 |

---

## 七、其他后端 endpoint

| Endpoint | 用途 |
|---|---|
| `GET /monai/nifti-segs/{series_uid}` | 列出全部草稿 |
| `GET /monai/nifti-segs/{series_uid}/{filename}` | 获取单个草稿 (multipart) |
| `DELETE /monai/nifti-segs/{series_uid}/{filename}` | 删除草稿 |
| `POST /monai/nifti-segs/{series_uid}` | 保存草稿 (Save Draft / Save All 使用) |
| `POST /monai/nifti-segs/{series_uid}/load-session` | 加载草稿到 nnInteractive session 缓冲区 |
| `POST /monai/infer/save/{model}` | 发布为 DICOM-SEG (Save to PACS) |
| `POST /monai/infer/save-nifti/{model}` | (旧) 保存全 segment 快照 (`edited_seg_*`) |
| `POST /monai/infer/{model}` | 推理 (nninter / voxtell / medgemma 通过 `data['nninter']` 字符串分发) |

---

## 八、关键路径速查

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 三个服务定义 + 卷挂载 |
| `monai-label/Dockerfile` | 后端镜像构建 (SAM2/MedSAM2 权重内置) |
| `monai-label/monailabel/tasks/infer/basic_infer.py` | 推理调度核心 |
| `monai-label/monailabel/endpoints/infer.py` | 推理 + 保存 HTTP 端点 |
| `monai-label/monailabel/endpoints/nifti_store.py` | NIfTI 草稿 CRUD |
| `monai-label/monailabel/utils/others/stream.py` | gzip multipart 流式输出 |
| `Viewers/extensions/default/src/commandsModule.ts` | 前端命令 (saveDraft / saveAll / loadDrafts) |
| `Viewers/modes/longitudinal/src/toolbarButtons.ts` | 工具栏按钮定义 |
| `Viewers/modes/longitudinal/src/index.ts` | toolbar section 配置 |
| `monai-label/nifti_segs/` | 主机端草稿存储 (容器内 `/code/nifti_segs/`) |

---

## 九、常见问题排查

### NVIDIA Driver/library version mismatch
内核驱动与用户态库版本不一致。**唯一解决：`sudo reboot`**。

### Docker 镜像不更新
前端代码改了但浏览器看到旧版：
```bash
docker compose build --no-cache ohif_viewer
docker compose up -d --force-recreate ohif_viewer
# 浏览器强制刷新 Ctrl+Shift+R
```

### Save Draft 报 "use Save NIfTI instead"
当前活跃的 segment 没有 `draftOrigin`（不是从草稿加载的）。用 **Save All** 代替 — 它会把新创建的 segment 当 "new" 保存。

### Load Drafts 显示数量与磁盘不符
`showDraftsList` 会过滤 `source="ohif_save_nifti"` 的旧 `edited_seg_*` 快照。`ls /code/nifti_segs/<series>/` 看到的是磁盘真实文件。

### 加载多个有重叠的草稿后部分 segment 显示为 NaN
共享 labelmap 中后加载的 segment 覆盖了先加载的 voxel。**当前实现仅对 refined→original 自动处理替换** (基于 origin 匹配)。其他完全独立但 voxel 重叠的草稿，加载顺序决定结果。
