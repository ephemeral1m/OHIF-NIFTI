# OHIF-AI 最小源码包

> 以下为 2026-08-12 原始来源包的历史记录。2026-10-09 GitHub 快照不包含认证文件、TLS 私钥或运行数据；当前说明见 `README.md` 与 `docs/CURRENT_STATE_2026-10-09.md`。

本包是 `/home/ubuntu/Documents/OHIF-AI` 在 2026-08-12 的可重建源码快照。

## 版本

- Git commit：`5688e619f33f6e0b885e36999846903074a6b71e`
- Git tag：`nifti-drafts-memory-v2-20260811`
- 分支：`local/nifti-drafts`
- 修复状态：`docs/NIFTI_DRAFT_FIX_STATUS_2026-08-11.md`

归档不包含 `.git` 历史，但源码内容取自上述已提交版本。

## 包含内容

- 当前 OHIF Viewer、MONAI Label、自定义 NIfTI draft 与 nnInteractive 相关源码。
- `package.json`、`yarn.lock`、`bun.lock`、Python requirements 和 Docker/Compose 文件。
- `Viewers/patches/@cornerstonejs+tools+3.33.5.patch`、补丁校验脚本及 `backup/` 定制文件。
- 当前 Nginx/Orthanc 配置。
- 为保证解压后可以直接启动，包含当前被 Git 忽略的 `.htpasswd` 和自签名 TLS 证书/私钥。部署到其他环境前必须更换它们。

## 有意排除

- `.git`、Codex/Claude 工作记录和 release artifacts。
- `node_modules`、Python cache、Docker image/layer 和构建产物。
- MONAI checkpoints、Hugging Face cache、模型权重、预测结果和 NIfTI 存储库。
- Orthanc 数据库、Nginx 日志和患者/病例数据。
- OHIF 文档站点、MONAI 文档图片、自动化测试目录、演示 PDF/GIF/ZIP 和 sample-data。

上述依赖、镜像、应用模板和模型在首次构建/启动时按现有代码逻辑从网络下载。本包因此不是离线安装包。

## 解压与启动

```bash
tar -xzf ohif-ai-source-minimal-5688e61-20260812.tar.gz
cd OHIF-AI
bash start.sh all
```

首次构建需要网络、Docker Compose、NVIDIA Container Toolkit、兼容的 NVIDIA 驱动和足够磁盘空间。虽然压缩源码包很小，依赖和模型下载后仍会占用较大空间。

仅重建 Viewer：

```bash
bash start.sh viewer
```

Viewer 构建必须输出：

```text
[Cornerstone stack labelmap patch] verified @cornerstonejs/tools 3.33.5
```

## 数据迁移

本包不包含现有医生标注、Orthanc 数据或模型缓存。如需迁移运行数据，应单独、安全地复制以下目录，不要放入公开源码包：

- `monai-label/nifti_segs/`
- `monai-label/predictions/`
- `monai-label/checkpoints/`
- `monai-label/hf_cache/`
- `Viewers/platform/app/.recipes/Nginx-Orthanc/volumes/`

