<p align="center">
  <img src="site/assets/youdub-logo.svg" alt="YouDub" width="520" />
</p>

# YouDub Desktop

开源视频本地化工作台：导入视频，识别、翻译并逐句克隆原声，生成字幕和配音成片。

[English](README.en.md) · [官网与试听](https://liuzhao1225.github.io/YouDub-webui/) · [下载最新版](https://github.com/liuzhao1225/YouDub-webui/releases/latest) · [安装与升级](docs/upgrade.md) · [社区交流](#社区交流)

## 效果示例

默认演示为 2026-10-09 生成的黄仁勋采访：逐句原声克隆、中文字幕与背景音保留，完整时长约 59 秒。源视频链接用于说明样例出处，工作台支持视频链接和本地文件导入。

### 1. 黄仁勋采访 · 最新效果

[原视频链接](https://www.youtube.com/shorts/TbotsRXyRME) · YouTube Shorts · 英文 -> 中文

<table>
<tr><th>原始英文</th><th>中文配音版</th></tr>
<tr>
<td>

https://github.com/user-attachments/assets/befd11ca-e720-4faa-b4e0-d89bfe73df87

</td>
<td>

https://github.com/user-attachments/assets/60d5dbb0-f346-4c14-adad-2d0c481ac4fb

</td>
</tr>
</table>

### 2. 历史样例：How much YT paid me for 129 million shorts views

[原视频链接](https://www.youtube.com/watch?v=ii9Kh4XkA5g) · YouTube 横屏长视频 · 英文 -> 中文 · 下方为开头 40 秒切片，完整版可在 [`demo-assets`](https://github.com/liuzhao1225/YouDub-webui/releases/tag/demo-assets) Release 下载

<table>
<tr><th>原始英文</th><th>中文配音版</th></tr>
<tr>
<td>

https://github.com/user-attachments/assets/bd02936f-cf3c-4e4b-85b5-0410d38f69f5

</td>
<td>

https://github.com/user-attachments/assets/158de60a-7de4-4ddf-b3d8-478d0423aee6

</td>
</tr>
</table>

### 3. Me at the zoo

[原视频](https://www.youtube.com/watch?v=jNQXAC9IVRw) · 英文 → 中文 · 19 秒

[在官网切换中英文试听](https://liuzhao1225.github.io/YouDub-webui/?demo=zoo#demo)。工作台和环境准备页的“查看官网示例”打开官网试听。安装包只保留黄仁勋采访原视频，可直接用作本地工作流输入。

## 能做什么

| 输出模式 | 生成内容 |
| --- | --- |
| 原声 + 字幕 | 保留原始音轨，生成并烧录目标语言字幕 |
| 配音 | 生成目标语言配音，可保留分离后的背景音 |
| 字幕 + 配音 | 输出带字幕的配音视频，可选语音强制对齐 |

- **逐句原声克隆。** 每句译文使用对应原文句子的音频片段作为参考，保留句子与参考音频的一一对应关系。
- **字幕显示。** 按逗号、顿号、中文破折号等拆分显示，合并过短片段，隐藏字幕片段末尾的分隔标点。
- **任务管理。** 查看封面、步骤进度、错误和产物，支持取消、重试、重新生成、播放及下载。

工作台选择视频和工作流，并显示节点声明的快捷设置。语言、模型、设备、声音和字幕参数保存在工作流节点中；模型供应商、本地环境与模型安装在设置中管理。

## 界面预览

工作台：导入视频，选择语言和输出内容。

![YouDub 工作台：视频导入、原文与目标语言、配音与字幕选项](docs/images/workbench.jpg)

<details>
<summary>查看任务库与任务详情</summary>

任务库：视频封面、处理状态和历史任务。

![YouDub 任务库：视频封面与已完成任务](docs/images/task-library.jpg)

任务详情：成片预览、处理步骤、配音音频和字幕下载。

![YouDub 任务详情：带中文字幕的成片、八个已完成步骤与生成文件](docs/images/task-detail.jpg)

</details>

## 下载与使用

[Windows EXE 安装包](https://github.com/liuzhao1225/YouDub-webui/releases/latest/download/YouDub-windows-x64-Setup.exe) · [macOS DMG](https://github.com/liuzhao1225/YouDub-webui/releases/latest/download/YouDub-macOS-arm64.dmg) · [版本说明与便携包](https://github.com/liuzhao1225/YouDub-webui/releases/latest)

首次启动准备基础运行环境；所需模型和推理依赖按工作流准备。安装要求与升级方法见[安装指南](docs/upgrade.md)。

1. 在「设置 → LLM 供应商」添加供应商、密钥和翻译模型。
2. 在「工作台」导入视频，选择工作流并调整节点选项，按提示准备所需资源后创建任务。
3. 在「任务库」查看进度，播放或下载结果。

## 社区交流

QQ 交流群：`618246010`

<p align="center">
  <img src="apps/web/public/qq-group-618246010.jpg" alt="YouDub QQ 交流群二维码" width="220" />
</p>

## 从源码运行 YouDub Desktop

YouDub 采用纯粹的三层架构：超薄 **Electron 桌面壳**（`apps/desktop`） + **Vite 8 React 19 SPA**（`apps/web`） + **纯 Python FastAPI 运行时**（`backend/app/server` + `backend/app/v1`）。

环境要求：Node.js `^22.19.0 || >=24.0.0`、Python `3.12`（`.venv` 或 `uv`）、npm 与 Git。在仓库根目录执行：

```bash
npm --prefix apps/web ci --registry=https://registry.npmmirror.com
npm --prefix apps/desktop ci --registry=https://registry.npmmirror.com
npm run build
npm start
```

开发联调与辅助命令：

- `npm run dev`：同时启动 Python FastAPI（`8765`）、Vite 8 开发服务器（`5173`）与 Electron 窗口。
- `npm run dev:web` / `node scripts/dev.mjs --web-only`：仅启动浏览器前端与 Python 后端进行本地调试。
- `npm run package:desktop -- --dir`：打包独立桌面应用；正式安装包、签名与发布见[发行流程](docs/releasing.md)。

首次启动选择界面语言和数据目录，页面会检查 FFmpeg、`yt-dlp`、Python 依赖和本地模型准备状态（Whisper 默认使用 `large-v3-turbo`，也可按需切换下载其他 Whisper 模型或一键更新 `yt-dlp`）。

## 架构概览

```text
apps/desktop (Electron 主进程 & safeStorage 凭据桥)
      ↕  HTTP / SSE (/api/events)
backend/app/server (FastAPI + SQLite WAL + DAG 引擎 + LLM 翻译 + ResourceManager)
      ↕  子进程 ML 执行
backend/app/v1 (Whisper + SentenceX + Demucs + Qwen Aligner + VoxCPM2 + FFmpeg)
```

- **单后端控制面**：`backend/app/server/` 统一承载 `/api/*` REST 接口、`/api/events` 单通道 SSE、`LLMProvider`（支持 OpenAI / Anthropic / Gemini 协议与断点续翻）、任务队列与 DAG 调度，并按需拉起独立 Python 子进程执行重型推理并在完成后释放显存。
- **独立前端 SPA**：`apps/web/` 使用 Vite 8、React 19、Tailwind CSS v4 与 `@xyflow/react`，自主持有全部 UI 原语、样式变量、国际化与工作流/校对页面。
- **超薄桌面壳**：`apps/desktop/` 仅负责单实例锁、本机 `safeStorage` 加密桥、FastAPI 进程守护、原生窗口标题栏、目录选择与应用自动更新。

## 当前范围

- **智能分句**：Whisper 识别后使用 `SentenceX` 与词级时间戳整理完整句子边界，保留逐字时间映射。
- **翻译引擎**：支持 OpenAI、Anthropic、Gemini 协议，支持多轮滑动上下文与按句持久化断点续传。
- **输入兼容**：支持本地常见视频格式及 YouTube / Shorts / B 站 / b23.tv 链接，不设视频时长、文件大小、分辨率或帧率人为上限。
- **工作流编辑**：基于 `@xyflow/react` 支持有向无环图编排、节点参数配置、人工审核停顿及节点级订正重跑。

## 开发与测试

```bash
.venv/bin/pytest
npm run typecheck
npm run lint
npm test
npm run build
```

```text
backend/app/server/  FastAPI 控制面、SQLite 持久化、DAG 调度、LLM 客户端、资源管理与 SSE Hub
backend/app/v1/      Whisper、Demucs、Qwen Aligner、VoxCPM2 与 FFmpeg 媒体处理内核
backend/tests/       Python 后端与推理阶段单元测试（pytest）
apps/web/            Vite 8 + React 19 + Tailwind CSS v4 SPA 前端、UI 原语、画布与校对页面
apps/desktop/        超薄 Electron 桌面壳（main.ts / preload.ts / inno-updater.ts）
scripts/             开发联调、桌面打包、macOS 签名与更新源工具脚本
submodule/demucs/    Demucs 源码子模块
```

欢迎通过 Issue / PR 改进安装体验、适配模型或优化字幕与音画对齐。详细模块文档见 [Web 前端说明](apps/web/README.md) 与 [桌面端说明](apps/desktop/README.md)。

## 开源许可

本项目使用 Apache License 2.0，详见 [LICENSE](LICENSE)。

国内镜像：[AtomGit](https://atomgit.com/liuzhao1225/YouDub-webui)，由 [GitHub 主仓库](https://github.com/liuzhao1225/YouDub-webui)单向同步。Release、Issue 和 PR 在 GitHub 维护。

作者：[刘朝 Zhao Liu](https://liuzhao1225.github.io/) · [GitHub](https://github.com/liuzhao1225) · [Bilibili 黑纹白斑马](https://space.bilibili.com/1263732318)

[Star History](https://www.star-history.com/?repos=liuzhao1225%2FYouDub-webui&type=date&legend=top-left)
