<p align="center">
  <img src="site/assets/youdub-logo.svg" alt="YouDub" width="520" />
</p>

# YouDub Desktop

An open-source video localization workspace: import a video, transcribe and translate its speech, clone each sentence from its source audio, and produce subtitles and dubbed video.

[中文](README.md) · [Website and demos](https://liuzhao1225.github.io/YouDub-webui/) · [Download latest](https://github.com/liuzhao1225/YouDub-webui/releases/latest) · [Installation and upgrade](docs/upgrade.md) · [Community](#community)

## Demo

The default demo is the Jensen Huang interview generated on 2026-10-09: sentence-level voice cloning, Chinese subtitles and preserved background audio, approximately 59 seconds long. Source links identify the original videos; the workspace accepts video links and local files.

### 1. Jensen Huang interview · Latest result

[YouTube source](https://www.youtube.com/shorts/TbotsRXyRME) · YouTube Shorts · English -> Chinese

<table>
<tr><th>Original English</th><th>Chinese dubbed</th></tr>
<tr>
<td>

https://github.com/user-attachments/assets/befd11ca-e720-4faa-b4e0-d89bfe73df87

</td>
<td>

https://github.com/user-attachments/assets/60d5dbb0-f346-4c14-adad-2d0c481ac4fb

</td>
</tr>
</table>

### 2. Earlier sample: How much YT paid me for 129 million shorts views

[YouTube source](https://www.youtube.com/watch?v=ii9Kh4XkA5g) · Long-form landscape video · English -> Chinese · The embedded clip shows the first 40 seconds; the full version is available in the [`demo-assets`](https://github.com/liuzhao1225/YouDub-webui/releases/tag/demo-assets) release

<table>
<tr><th>Original English</th><th>Chinese dubbed</th></tr>
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

[YouTube source](https://www.youtube.com/watch?v=jNQXAC9IVRw) · English → Chinese · 19 seconds

[Switch between English and Chinese on the website](https://liuzhao1225.github.io/YouDub-webui/?demo=zoo#demo). Desktop packages include all three examples for offline playback through “View built-in examples” on the workspace or setup screen.

## Features

| Output mode | Result |
| --- | --- |
| Original audio + subtitles | Preserve the original audio and burn target-language subtitles into the video |
| Dubbing | Generate target-language speech, optionally retaining separated background audio |
| Subtitles + dubbing | Produce a dubbed video with subtitles and optional forced alignment |

- **Sentence-level voice cloning.** Each translated sentence uses the corresponding source sentence's audio as its reference, preserving a one-to-one mapping.
- **Subtitle display.** Split display cues at commas, Chinese enumeration commas and dashes, merge very short cues, and hide trailing separator punctuation.
- **Task management.** View covers, step progress, errors and artifacts; cancel, retry, rerun, play or download results.

The workspace lets you choose a video and workflow, then adjust the quick settings declared by its nodes. Languages, models, devices, voices and subtitle options belong to workflow nodes. Settings manages model providers, the local environment and model installation.

## Interface Preview

The workspace: import a video and choose languages and output mode. Screenshots show the current Chinese interface.

![YouDub workspace with video import, source and target languages, and output choices](docs/images/workbench.jpg)

<details>
<summary>View the task library and task details</summary>

Task library: video covers, processing status and previous tasks.

![YouDub task library showing video covers and completed tasks](docs/images/task-library.jpg)

Task details: preview the video, inspect processing steps, and download dubbed audio and subtitles.

![YouDub task details with Chinese subtitles, eight completed steps and generated files](docs/images/task-detail.jpg)

</details>

## Download and Use

[Windows EXE installer](https://github.com/liuzhao1225/YouDub-webui/releases/latest/download/YouDub-windows-x64-Setup.exe) · [macOS DMG](https://github.com/liuzhao1225/YouDub-webui/releases/latest/download/YouDub-macOS-arm64.dmg) · [Release notes and portable package](https://github.com/liuzhao1225/YouDub-webui/releases/latest)

First startup prepares the base runtime. Models and inference dependencies are prepared for the selected workflow. See the [installation guide](docs/upgrade.md) for requirements and upgrade instructions.

1. Add an LLM provider, API key, and translation model in Settings → LLM Providers.
2. Import a video in the workspace, choose a workflow and adjust its node options, then prepare the required resources and create a task.
3. In the task library, follow progress and play or download the result.

## Community

QQ group: `618246010`

<p align="center">
  <img src="apps/web/public/qq-group-618246010.jpg" alt="YouDub QQ group QR code" width="220" />
</p>

## Run YouDub Desktop from source

YouDub uses a clean three-layer architecture: an ultra-thin **Electron desktop shell** (`apps/desktop`), a **Vite 8 + React 19 SPA** (`apps/web`), and a **pure Python FastAPI runtime** (`backend/app/server` + `backend/app/v1`).

Requirements: Node.js `^22.19.0 || >=24.0.0`, Python `3.12` (`.venv` or `uv`), npm, and Git. Initialize submodules when cloning, then run from the repository root:

```bash
npm --prefix apps/web ci --registry=https://registry.npmmirror.com
npm --prefix apps/desktop ci --registry=https://registry.npmmirror.com
npm run build
npm start
```

Development commands:

- `npm run dev`: starts Python FastAPI (`8765`), Vite 8 dev server (`5173`), and the Electron window together.
- `npm run dev:web` / `node scripts/dev.mjs --web-only`: runs the Vite 8 SPA + Python FastAPI server for browser debugging.
- `npm run package:desktop -- --dir`: packages the standalone desktop app. See [release packaging](docs/releasing.md) for signing, notarization and installers.

On first launch, select the interface language and data directory, then prepare FFmpeg, `yt-dlp`, Python packages, and local ML models (Whisper defaults to `large-v3-turbo`, with optional variant downloads and one-click `yt-dlp` updates in Resources).

## Architecture Overview

```text
apps/desktop (Electron main process & safeStorage credential bridge)
      ↕  HTTP / SSE (/api/events)
backend/app/server (FastAPI + SQLite WAL + DAG engine + LLM client + ResourceManager)
      ↕  Child-process ML stages
backend/app/v1 (Whisper + SentenceX + Demucs + Qwen Aligner + VoxCPM2 + FFmpeg)
```

- **Single Python backend**: `backend/app/server/` owns `/api/*` REST endpoints, single-channel SSE (`/api/events`), multi-protocol LLM translation (OpenAI / Anthropic / Gemini with checkpointed per-sentence context), SQLite WAL persistence, and DAG execution spawning isolated Python stage subprocesses to release GPU/RAM cleanly after each stage.
- **Owned React 19 SPA**: `apps/web/` owns its Vite 8 build, Tailwind CSS v4 styles, UI primitives, `@xyflow/react` workflow canvas, node-level review editors, and Settings modal.
- **Ultra-thin Electron shell**: `apps/desktop/` handles single-instance lock, loopback `safeStorage` bridge, Python backend supervision, native macOS/Windows window chrome, directory picking, and auto-updates.

## Current Scope

- **Sentence segmentation**: Uses `SentenceX` with Whisper word timestamps to form clean sentence boundaries while preserving word-level timing.
- **Translation protocols**: Native support for OpenAI, Anthropic, and Gemini APIs with rolling context and per-sentence checkpoint recovery.
- **Inputs**: Supports local video formats and single-video YouTube, Shorts, Bilibili, and b23.tv URLs via `yt-dlp` + FFmpeg with no artificial duration or resolution caps.
- **Workflow graphs**: Directed acyclic workflows via `@xyflow/react` supporting per-node options, review pauses, inline subtitle/translation corrections, and partial reruns.

## Development and Tests

```bash
.venv/bin/pytest
npm run typecheck
npm run lint
npm test
npm run build
```

```text
backend/app/server/  FastAPI control plane, SQLite store, DAG runner, LLM client, ResourceManager & SSE hub
backend/app/v1/      Whisper, Demucs, Qwen Aligner, VoxCPM2 & FFmpeg media processing core
backend/tests/       Python backend and ML pipeline unit tests (pytest)
apps/web/            Vite 8 + React 19 + Tailwind CSS v4 SPA, UI primitives, canvas & review editors
apps/desktop/        Ultra-thin Electron shell (main.ts / preload.ts / inno-updater.ts)
scripts/             Dev runner, desktop packager, macOS signing & update feed scripts
submodule/demucs/    Demucs source submodule
```

Issues and pull requests are welcome for installation improvements, model adapters, and subtitle or audio/video alignment. See [Web UI notes](apps/web/README.md) and [Desktop notes](apps/desktop/README.md) for module details.

## License

This project is licensed under Apache License 2.0. See [LICENSE](LICENSE).

China mirror: [AtomGit](https://atomgit.com/liuzhao1225/YouDub-webui), synchronized one way from the [primary GitHub repository](https://github.com/liuzhao1225/YouDub-webui). Releases, issues and pull requests are maintained on GitHub.

Creator: [Zhao Liu](https://liuzhao1225.github.io/en/) · [GitHub](https://github.com/liuzhao1225) · [Bilibili 黑纹白斑马](https://space.bilibili.com/1263732318)

[Star History](https://www.star-history.com/?repos=liuzhao1225%2FYouDub-webui&type=date&legend=top-left)
