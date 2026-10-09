# OHIF-NIFTI / OHIF-AI

基于 OHIF 3.10.4、Cornerstone 3.33.5 与 MONAI Label 的医学影像研究工作台，支持既有 DICOM 流程及原生三维 NIfTI 浏览、分割编辑、nnInteractive 和版本化 mask。

当前代码快照：**2026-10-09**。完整状态、验证范围及待办见 [当前开发状态](docs/CURRENT_STATE_2026-10-09.md)。这是研究与调试版本。

## 当前功能

- NIfTI `.nii` / `.nii.gz` 本地打开与服务器原图库，CSV/JSON 清单导入。
- 服务器原图按层无损渐进加载，中间层优先，邻近 ±8 层预取；MPR、球形笔刷、插值按需补齐体数据。
- 独立 mask、多标签拆分、重叠展示、透明度与边界控制、版本历史及 NIfTI ZIP 导出。
- nnInteractive 原生 NIfTI context v2；保留 DICOM v1 与既有 PACS 工作流。
- 报告、Finding、mask 的清单关联；左侧完整病例树、原地切换病例、右侧报告和标注面板。
- 黑紫色工作台；顶部可折叠标注工具、MPR 工具切换与 Crosshairs 开关。

## 本地开发

使用 Docker Desktop Linux 引擎；AI 需要兼容 NVIDIA GPU 与本地模型权重。

```powershell
.\deploy\local\Start-Local.ps1
```

浏览器打开 `http://127.0.0.1:1026/nifti`。这个入口使用源码挂载与热更新。
当前开发 Compose 依赖本机已存在的 `monai:latest`、`webapp:latest` 和 Orthanc 镜像；从全新机器启动还需准备镜像和权重，不能将本快照视作离线即用安装包。

详见 [本地启动与 Tailscale](deploy/local/README.md)、[原生 NIfTI 部署与回退](deploy/nifti/README.md)、[ReX 报告工作台](deploy/datasets/rexgroundingct/WORKSPACE.md)。

## 配置与数据

源码库不包含影像、已有标注、模型权重、Docker 数据卷、认证文件或 TLS 私钥。
ReX 数据和机器专属挂载由准备脚本生成，参见 [数据准备说明](deploy/datasets/rexgroundingct/WORKSPACE.md)。

项目根目录的旧生产 Compose 与 `deploy/local` 是不同部署入口。使用旧入口前：

1. 将 `.env.example` 复制为 `.env`，填写 DICOMweb 用户名和密码。
2. 将 `Viewers/platform/app/.recipes/Nginx-Orthanc/config/orthanc.example.json` 复制为同目录 `orthanc.json`，使 `RegisteredUsers` 与 `.env` 一致。
3. 按部署说明自行准备 `.htpasswd` 与 TLS 材料；这些文件均被 Git 忽略。

不要删除现有数据卷来重置开发环境。Git 源码备份不能代替原图库、SQLite 索引及 mask 版本的独立备份。

## 来源与许可

上游为 [CCI-Bonn/OHIF-AI](https://github.com/CCI-Bonn/OHIF-AI)。本目录由不含 `.git` 的源码包发展而来；其原始基线为 `5688e619f33f6e0b885e36999846903074a6b71e`，详见 [来源记录](SOURCE_PACKAGE.md)。当前仓库从本次快照建立历史，不声称包含上游全部 Git 提交。

保留根目录及各子项目中的 LICENSE 与第三方版权声明。
