# 本地开发

在 PowerShell 中，从 `E:\ohif-ai` 执行：

```powershell
.\deploy\local\Start-Local.ps1
```

需要 Docker Desktop 的 Linux 引擎运行，并保留本机已有的 `monai:latest`、`webapp:latest` 和 `jodogne/orthanc-plugins:latest` 镜像。首次启动安装 `Viewers/yarn.lock` 锁定的前端依赖，之后复用开发环境专属的依赖卷。安装完成前页面可能返回 502。

- NIfTI：<http://127.0.0.1:1026/nifti>
- DICOM：<http://127.0.0.1:1026/>
- 健康状态：<http://127.0.0.1:1026/monai/health>
- 后端 API 调试端口：`127.0.0.1:8002`

前端直接挂载 `Viewers`，启用源码监视与热更新。Docker 中的依赖位于独立 Linux 卷；不要直接在 Windows 运行 Yarn 去覆盖它们。依赖清单变化后执行 `.\deploy\local\Start-Local.ps1 frontend`，会重新核对并安装锁定依赖。项目原有 Cornerstone 替换文件、Stack labelmap 补丁及 interpolation 修复都会安装并校验。开发服务通过 API 启动，兼容当前锁定的 webpack-cli 4 与 webpack-dev-server 5，无需升级依赖。

后端直接挂载 `monai-label/monailabel` 和 radiology 的 `main.py`、`lib`。修改 Python 后执行：

```powershell
.\deploy\local\Start-Local.ps1 backend
```

nnInteractive 使用本机 `monai-label/checkpoints/nnInteractive_v1.0` 的权重和 GPU 0，惰性加载。原图库、stream 缓存、mask 和 Orthanc 使用 `ohif-local-dev_` 开头的独立持久卷。

服务器路径形式的 CSV/JSON 在这个环境中使用 `/local-input` 为基准，对应 Windows 的 `E:\ohif-ai\local-data\input`。例如 CSV 写 `case01.nii.gz,case01-mask.nii.gz`。可以直接从首页选择本地 NIfTI；上传或保存后会进入本地开发原图库。

已准备合成 CT、MR 和对应多标签 mask，以及 `local-data/input/demo.csv`。在 NIfTI 首页选择该清单，基准目录选择 `/local-input`；原图库也已登记这两例。DICOM 首页另有一例 24 层的合成 CT。测试图像均为人工 phantom，供开发使用。

```powershell
.\deploy\local\Start-Local.ps1 status
.\deploy\local\Start-Local.ps1 logs
.\deploy\local\Start-Local.ps1 stop
```

`stop` 保留数据和依赖卷。这个开发入口仅绑定本机回环地址，使用 HTTP；localhost 满足浏览器的安全上下文条件。前后端 NIfTI streaming 在这个开发环境中成套开启，正式发布配置保持原样。

2026-10-09 本机验收通过：CT/MR 原图及 mask 导入、压缩切片逐值校验、96 层原图仅载入中间邻近 17 层、画笔、真实 GPU nnInteractive、保存后通过历史 UI 逐体素重载、MPR 补齐、DICOM 列表及看图、源码修改与恢复的浏览器热更新。记录和截图位于 `local-data/acceptance`。验收使用合成 phantom，未测试大型真实病例的性能。

重新导入并验证测试数据：

```powershell
Get-Content .\deploy\local\seed-local.py -Raw | docker exec -i ohif-local-dev-backend-1 python -
```

`smoke.cjs` 可用 Node + Playwright 复测；`PLAYWRIGHT_MODULE` 指向 Playwright 模块，`CHROMIUM_EXECUTABLE` 指向 Edge/Chrome 可执行文件。运行前将上述 seed 输出存为 `local-data/acceptance/api.json`。`hmr-check.cjs` 会临时添加源码注释、观察热更新并恢复文件，运行时应避免同时编辑 Gateway.tsx。

通过 Tailscale 访问：

```powershell
.\deploy\local\Publish-Tailnet.ps1
.\deploy\local\Publish-Tailnet.ps1 status
.\deploy\local\Publish-Tailnet.ps1 stop
```

默认将本机 `127.0.0.1:1026` 代理到本机 Tailscale 域名的 HTTPS 9443。脚本读取本机域名、写入忽略版本管理的 `tailnet.json` 并在需要时重启前端，以允许该域名及 WSS 热更新连接。现有其他端口的 Serve 配置不变；9443 若属于其他服务会拒绝覆盖，可用 `-Port` 另选端口。`stop` 仅撤销这个 HTTPS 入口。

当前入口为 <https://laptop-9snt9abs.tailb37712.ts.net:9443/nifti>，DICOM 位于同域名 `/`。2026-10-09 已从本机通过该 HTTPS 域名验证证书、原图库 API、NIfTI 17 层加载、DICOM 列表与 WSS，结果在 `local-data/acceptance/tailnet.json`。未从第二台设备实测。

工作台采用“暮紫＋青橙”配色。共用颜色变量位于 `Viewers/extensions/default/src/ViewerLayout/workbench-palette.css`：紫色为操作与选中态，青色为影像入口/浏览工具，暖橙色为报告与待确认关联。标注目标的 LUT、原图灰度和数据格式不受界面主题影响。开发容器通过源文件挂载更新样式，当前 Tailscale 入口同步使用这套界面；浏览器保留旧样式时先保存编辑，再刷新。可用 `deploy/local/palette-check.cjs` 检查实际界面，截图与结果写入 `local-data/acceptance/palette-*` 和 `palette.json`。

访问设备须连接该 tailnet，并满足 tailnet 的访问规则；服务主机须开机联网且 Docker Desktop、Tailscale 和本地开发容器运行。这个入口共享本地开发原图库、标注及 PACS；它使用 [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 在 tailnet 内提供服务，未开启公网 Funnel。
