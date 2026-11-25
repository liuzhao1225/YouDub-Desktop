"""Built-in node catalog, workflow templates, and static DAG validation."""

from __future__ import annotations

import copy
from collections import deque
from typing import Any

from .resources import ResourceManager
from .settings import LLMProviderConfig, SettingsStore

_LANG_ZH = "中文"
_LANG_EN = "English"
_LANG_JA = "日本語"
_LANG_AUTO = {"default": "Auto-detect", "translations": {"zh": "自动识别", "ja": "自動検出"}}


def _lt(default: str, *, zh: str, ja: str) -> dict[str, Any]:
    return {"default": default, "translations": {"zh": zh, "ja": ja}}


def _resolve_model_devices(resources: ResourceManager, *, allow_mps: bool) -> list[str]:
    devices = resources.detect_compute_devices()
    out = [d["id"] for d in devices if d.get("available") and (allow_mps or d["id"] != "mps")]
    return out or ["cpu"]


def _download_node(
    node_type: str, *, label: dict[str, Any], operation: str, port: str,
    port_label: dict[str, Any], schema_id: str, available: bool,
) -> dict[str, Any]:
    return {
        "type": node_type,
        "version": "1.0.0",
        "label": label,
        "category": "input",
        "providerId": "youdub.download",
        "operation": operation,
        "provider": {
            "id": "youdub.download",
            "label": _lt("yt-dlp", zh="yt-dlp 下载", ja="yt-dlp"),
            "operations": [{"id": operation}],
            "execution": "local",
            "ready": available,
            "available": available,
            "models": [],
        },
        "inputs": [],
        "outputs": [
            {
                "name": port,
                "label": port_label,
                "kind": "artifact",
                "schemaId": schema_id,
                "required": True,
            }
        ],
        "runtimeInputSchema": {
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {
                    "type": "string",
                    "title": _lt("Video URL", zh="视频链接", ja="動画 URL"),
                    "description": _lt(
                        "Paste a YouTube or Bilibili video link.",
                        zh="粘贴 YouTube 或 Bilibili 视频链接。",
                        ja="YouTube または Bilibili の動画リンクを貼り付けます。",
                    ),
                }
            },
        },
        "configSchema": {
            "type": "object",
            "properties": {
                "proxyPort": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 65535,
                    "default": 0,
                    "x-title": _lt("Download proxy port", zh="下载代理端口", ja="ダウンロードプロキシポート"),
                    "x-short-title": _lt("Proxy", zh="代理端口", ja="プロキシ"),
                }
            },
        },
        "defaults": {"proxyPort": 0},
    }


def build_node_types(settings: SettingsStore, resources: ResourceManager) -> list[dict[str, Any]]:
    """Return every built-in NodeTypeDefinition for the DAG canvas and validator."""
    local_devices = _resolve_model_devices(resources, allow_mps=True)
    whisper_devices = _resolve_model_devices(resources, allow_mps=False)
    installed_whisper = set(resources.installed_whisper_variants())
    voxcpm_ready = resources.is_model_ready("voxcpm")
    demucs_ready = resources.is_model_ready("demucs")
    qwen_ready = resources.is_model_ready("qwen")

    whisper_variants = [
        ("large-v3-turbo", "Large v3 Turbo (Recommended)"),
        ("large-v3", "Large v3"),
        ("medium", "Medium"),
        ("small", "Small"),
        ("tiny", "Tiny"),
    ]
    whisper_models = [
        {
            "id": model_id,
            "name": label,
            "available": model_id in installed_whisper,
            **({} if model_id in installed_whisper else {"unavailableReason": f"Whisper {model_id} model is not downloaded."}),
            "devices": whisper_devices,
            "source_languages": ["auto", "en", "zh", "ja"],
        }
        for model_id, label in whisper_variants
    ]

    llm_providers = settings.config.llm_providers or []
    translation_nodes: list[dict[str, Any]] = []
    for p in llm_providers:
        if not p.enabled:
            continue
        view = settings.provider_view(p)
        models = list(dict.fromkeys([*(p.models or []), *([p.default_model] if p.default_model else [])]))
        translation_nodes.append(
            _translate_node_def(
                provider_id=p.id,
                provider_label=p.name,
                available=bool(view["available"]),
                unavailable_reason=view.get("unavailableReason"),
                models=models,
            )
        )
    if not any(n["providerId"] == "openai" for n in translation_nodes) and not translation_nodes:
        translation_nodes.append(
            _translate_node_def(
                provider_id="openai",
                provider_label="OpenAI / DeepSeek",
                available=False,
                unavailable_reason="Provider connection is not configured.",
                models=[],
            )
        )

    download_available = bool(resources.yt_dlp_version())
    return [
        _download_node(
            "youdub.download", label=_lt("Video Link Download", zh="视频链接下载", ja="動画リンクダウンロード"),
            operation="video.download/v1", port="video", port_label=_lt("Video", zh="视频", ja="動画"),
            schema_id="video/mp4/v1", available=download_available,
        ),
        _download_node(
            "youdub.downloadAudio", label=_lt("Audio Link Download", zh="音频链接下载", ja="音声リンクダウンロード"),
            operation="audio.download/v1", port="audio", port_label=_lt("Audio", zh="音频", ja="音声"),
            schema_id="audio/file/v1", available=download_available,
        ),
        {
            "type": "youdub.importSubtitles",
            "version": "1.0.0",
            "label": _lt("Import Subtitles", zh="导入字幕", ja="字幕インポート"),
            "category": "input",
            "providerId": "youdub.media",
            "operation": "subtitles.import/v1",
            "provider": {
                "id": "youdub.media",
                "label": _lt("FFmpeg Media", zh="本地媒体处理", ja="FFmpeg メディア"),
                "operations": [{"id": "subtitles.import/v1"}],
                "execution": "local",
                "ready": True,
                "available": True,
                "models": [],
            },
            "inputs": [
                {
                    "id": "subtitles",
                    "label": _lt("Subtitles (.srt)", zh="字幕文件 (.srt)", ja="字幕 (.srt)"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["application/x-subrip/v1", "file/v1"],
                    "required": True,
                }
            ],
            "outputs": [
                {
                    "name": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "schemaId": "youdub.transcript/v1",
                    "required": True,
                }
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "sourceLanguage": {
                        "type": "string",
                        "default": "en",
                        "x-title": _lt("Subtitle language", zh="字幕语言", ja="字幕言語"),
                        "x-short-title": _lt("Language", zh="语言", ja="言語"),
                        "x-options": [
                            {"value": "en", "label": _LANG_EN},
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    }
                },
            },
            "defaults": {"sourceLanguage": "en"},
            "corrections": {"outputPorts": ["transcript"], "schemaIds": ["youdub.transcript/v1"]},
        },
        {
            "type": "youdub.prepare",
            "version": "1.0.0",
            "label": _lt("Prepare Media", zh="解析视频媒体", ja="メディア準備"),
            "category": "media",
            "providerId": "youdub.media",
            "operation": "media.prepare/v1",
            "provider": {
                "id": "youdub.media",
                "label": _lt("FFmpeg Media", zh="本地媒体处理", ja="FFmpeg メディア"),
                "operations": [{"id": "media.prepare/v1"}],
                "execution": "local",
                "ready": True,
                "available": True,
                "models": [],
            },
            "inputs": [
                {
                    "id": "video",
                    "label": _lt("Media", zh="媒体文件", ja="メディア"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["file/v1", "video/mp4/v1", "audio/file/v1", "audio/wav/v1"],
                    "required": True,
                }
            ],
            "outputs": [
                {
                    "name": "sourceAudio",
                    "label": _lt("Source audio", zh="原声音频", ja="原音声"),
                    "kind": "artifact",
                    "schemaId": "audio/wav/v1",
                    "required": True,
                },
                {
                    "name": "mediaInfo",
                    "label": _lt("Media info", zh="媒体信息", ja="メディア情報"),
                    "kind": "json",
                    "schemaId": "youdub.mediaInfo/v1",
                    "required": True,
                },
            ],
            "configSchema": {"type": "object", "properties": {}},
            "defaults": {},
        },
        {
            "type": "youdub.separate",
            "version": "1.0.0",
            "label": _lt("Separate Vocals", zh="分离人声与背景", ja="ボーカル分離"),
            "category": "audio",
            "providerId": "demucs",
            "operation": "audio.separate/v1",
            "provider": {
                "id": "demucs",
                "label": _lt("Demucs", zh="Demucs 人声分离", ja="Demucs"),
                "operations": [{"id": "audio.separate/v1"}],
                "execution": "local",
                "ready": demucs_ready,
                "available": demucs_ready,
                "models": [
                    {
                        "id": "htdemucs",
                        "name": "htdemucs",
                        "available": demucs_ready,
                        **({} if demucs_ready else {"unavailableReason": "Demucs htdemucs checkpoint is missing."}),
                        "devices": local_devices,
                    }
                ],
            },
            "inputs": [
                {
                    "id": "sourceAudio",
                    "label": _lt("Source audio", zh="原声音频", ja="原音声"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["audio/wav/v1"],
                    "required": True,
                }
            ],
            "outputs": [
                {
                    "name": "vocals",
                    "label": _lt("Vocals", zh="人声", ja="ボーカル"),
                    "kind": "artifact",
                    "schemaId": "audio/wav/v1",
                    "required": True,
                },
                {
                    "name": "background",
                    "label": _lt("Background", zh="背景音", ja="BGM"),
                    "kind": "artifact",
                    "schemaId": "audio/wav/v1",
                    "required": True,
                },
            ],
            "configSchema": {"type": "object", "properties": {}},
            "defaults": {},
        },
        {
            "type": "youdub.transcribe",
            "version": "1.0.0",
            "label": _lt("Transcribe Speech", zh="语音识别", ja="音声認識"),
            "category": "speech",
            "providerId": "whisper",
            "operation": "speech.transcribe/v1",
            "provider": {
                "id": "whisper",
                "label": _lt("Whisper", zh="Whisper 本地识别", ja="Whisper"),
                "operations": [{"id": "speech.transcribe/v1"}],
                "execution": "local",
                "ready": bool(installed_whisper),
                "available": bool(installed_whisper),
                "models": whisper_models,
            },
            "inputs": [
                {
                    "id": "audio",
                    "label": _lt("Audio", zh="音频", ja="音声"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["audio/wav/v1"],
                    "required": True,
                },
                {
                    "id": "mediaInfo",
                    "label": _lt("Media info", zh="媒体信息", ja="メディア情報"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.mediaInfo/v1"],
                    "required": False,
                },
            ],
            "outputs": [
                {
                    "name": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "schemaId": "youdub.transcript/v1",
                    "required": True,
                }
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "sourceLanguage": {
                        "type": "string",
                        "default": "auto",
                        "x-title": _lt("Source language", zh="原文语言", ja="元の言語"),
                        "x-short-title": _lt("Source", zh="原文语言", ja="元の言語"),
                        "x-optionsFrom": "source_languages",
                        "x-options": [
                            {"value": "auto", "label": _LANG_AUTO},
                            {"value": "en", "label": _LANG_EN},
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    },
                    "initialPrompt": {
                        "type": "string",
                        "default": "",
                        "x-title": _lt("Recognition prompt", zh="识别提示词", ja="認識プロンプト"),
                    },
                },
            },
            "defaults": {"sourceLanguage": "auto"},
            "ui": {"quickFields": ["sourceLanguage"]},
            "corrections": {"outputPorts": ["transcript"], "schemaIds": ["youdub.transcript/v1"]},
        },
        *translation_nodes,
        {
            "type": "youdub.reference",
            "version": "1.0.0",
            "label": _lt("Extract Voice References", zh="提取克隆参考音频", ja="音声参照抽出"),
            "category": "speech",
            "providerId": "youdub.media",
            "operation": "speech.reference/v1",
            "provider": {
                "id": "youdub.media",
                "label": _lt("FFmpeg Media", zh="本地媒体处理", ja="FFmpeg メディア"),
                "operations": [{"id": "speech.reference/v1"}],
                "execution": "local",
                "ready": True,
                "available": True,
                "models": [],
            },
            "inputs": [
                {
                    "id": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.transcript/v1"],
                    "required": True,
                },
                {
                    "id": "audio",
                    "label": _lt("Vocals", zh="人声音频", ja="ボーカル音声"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["audio/wav/v1"],
                    "required": True,
                },
            ],
            "outputs": [
                {
                    "name": "references",
                    "label": _lt("Speaker references", zh="参考片段", ja="話者参照"),
                    "kind": "json",
                    "schemaId": "youdub.speakerReferences/v1",
                    "required": True,
                }
            ],
            "configSchema": {"type": "object", "properties": {}},
            "defaults": {},
        },
        {
            "type": "youdub.synthesize",
            "version": "1.0.0",
            "label": _lt("Synthesize Dubbed Speech", zh="语音克隆合成", ja="音声合成"),
            "category": "speech",
            "providerId": "voxcpm",
            "operation": "speech.synthesize/v1",
            "provider": {
                "id": "voxcpm",
                "label": _lt("VoxCPM2", zh="VoxCPM2 声音克隆", ja="VoxCPM2"),
                "operations": [{"id": "speech.synthesize/v1"}],
                "execution": "local",
                "ready": voxcpm_ready,
                "available": voxcpm_ready,
                "models": [
                    {
                        "id": "VoxCPM2",
                        "name": "VoxCPM2",
                        "available": voxcpm_ready,
                        **({} if voxcpm_ready else {"unavailableReason": "VoxCPM2 model weights are missing."}),
                        "devices": local_devices,
                        "target_languages": ["zh", "en", "ja"],
                        "voice_modes": ["source_clone"],
                        "voices": [],
                    }
                ],
            },
            "inputs": [
                {
                    "id": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.transcript/v1"],
                    "required": True,
                },
                {
                    "id": "translation",
                    "label": _lt("Translation", zh="译文文稿", ja="翻訳文"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.translation/v1"],
                    "required": True,
                },
                {
                    "id": "references",
                    "label": _lt("Speaker references", zh="参考片段", ja="話者参照"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.speakerReferences/v1"],
                    "required": False,
                },
            ],
            "outputs": [
                {
                    "name": "speechAudio",
                    "label": _lt("Speech clips", zh="合成语音", ja="合成音声"),
                    "kind": "json",
                    "schemaId": "youdub.speechAudio/v1",
                    "required": True,
                }
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "targetLanguage": {
                        "type": "string",
                        "default": "zh",
                        "x-title": _lt("Speech language", zh="配音语言", ja="音声言語"),
                        "x-short-title": _lt("Voice lang", zh="配音语言", ja="音声言語"),
                        "x-optionsFrom": "target_languages",
                        "x-options": [
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "en", "label": _LANG_EN},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    },
                    "voice": {
                        "type": "object",
                        "default": {"mode": "source_clone"},
                        "properties": {"mode": {"type": "string", "default": "source_clone"}},
                    },
                },
            },
            "defaults": {"targetLanguage": "zh", "voice": {"mode": "source_clone"}},
            "ui": {"quickFields": [], "editorId": "youdub.synthesize"},
        },
        {
            "type": "youdub.mix",
            "version": "1.0.0",
            "label": _lt("Mix Audio Timeline", zh="音频对齐与混音", ja="音声ミックス"),
            "category": "audio",
            "providerId": "youdub.media",
            "operation": "audio.mix/v1",
            "provider": {
                "id": "youdub.media",
                "label": _lt("FFmpeg Media", zh="本地媒体处理", ja="FFmpeg メディア"),
                "operations": [{"id": "audio.mix/v1"}],
                "execution": "local",
                "ready": True,
                "available": True,
                "models": [],
            },
            "inputs": [
                {
                    "id": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.transcript/v1"],
                    "required": True,
                },
                {
                    "id": "speechAudio",
                    "label": _lt("Speech clips", zh="合成语音", ja="合成音声"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.speechAudio/v1"],
                    "required": True,
                },
                {
                    "id": "mediaInfo",
                    "label": _lt("Media info", zh="媒体信息", ja="メディア情報"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.mediaInfo/v1"],
                    "required": True,
                },
                {
                    "id": "background",
                    "label": _lt("Background", zh="背景音", ja="BGM"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["audio/wav/v1"],
                    "required": False,
                },
            ],
            "outputs": [
                {
                    "name": "finalAudio",
                    "label": _lt("Mixed audio", zh="混合音轨", ja="ミックス音声"),
                    "kind": "artifact",
                    "schemaId": "audio/wav/v1",
                    "required": True,
                },
                {
                    "name": "dubbedTimeline",
                    "label": _lt("Dubbed timeline", zh="配音时间线", ja="吹替タイムライン"),
                    "kind": "json",
                    "schemaId": "youdub.dubbedTimeline/v1",
                    "required": True,
                },
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "keepBackground": {
                        "type": "boolean",
                        "default": True,
                        "x-title": _lt("Keep background audio", zh="保留背景音", ja="BGM を残す"),
                        "x-short-title": _lt("Background", zh="背景音", ja="BGM"),
                    }
                },
            },
            "defaults": {"keepBackground": True},
            "ui": {"quickFields": ["keepBackground"]},
        },
        {
            "type": "youdub.align",
            "version": "1.0.0",
            "label": _lt("Align Dubbed Subtitles", zh="配音字幕对齐", ja="字幕タイミング調整"),
            "category": "subtitles",
            "providerId": "qwen",
            "operation": "subtitles.align/v1",
            "provider": {
                "id": "qwen",
                "label": _lt("Qwen3 Aligner", zh="Qwen3 强制对齐", ja="Qwen3 アライナー"),
                "operations": [{"id": "subtitles.align/v1"}],
                "execution": "local",
                "ready": qwen_ready,
                "available": qwen_ready,
                "models": [
                    {
                        "id": "Qwen3-ForcedAligner-0.6B-hf",
                        "name": "Qwen3-ForcedAligner-0.6B-hf",
                        "available": qwen_ready,
                        **({} if qwen_ready else {"unavailableReason": "Qwen3 Aligner model is missing."}),
                        "devices": local_devices,
                        "target_languages": ["zh", "en", "ja"],
                    }
                ],
            },
            "inputs": [
                {
                    "id": "speechAudio",
                    "label": _lt("Speech clips", zh="合成语音", ja="合成音声"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.speechAudio/v1"],
                    "required": False,
                },
                {
                    "id": "dubbedTimeline",
                    "label": _lt("Dubbed timeline", zh="配音时间线", ja="吹替タイムライン"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.dubbedTimeline/v1"],
                    "required": True,
                },
                {
                    "id": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.transcript/v1"],
                    "required": True,
                },
                {
                    "id": "translation",
                    "label": _lt("Translation", zh="译文文稿", ja="翻訳文"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.translation/v1"],
                    "required": True,
                },
            ],
            "outputs": [
                {
                    "name": "alignedSubtitles",
                    "label": _lt("Aligned subtitles", zh="对齐字幕", ja="調整済み字幕"),
                    "kind": "json",
                    "schemaId": "youdub.alignedSubtitles/v1",
                    "required": True,
                }
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "targetLanguage": {
                        "type": "string",
                        "default": "zh",
                        "x-title": _lt("Alignment language", zh="对齐语言", ja="調整言語"),
                        "x-options": [
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "en", "label": _LANG_EN},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    }
                },
            },
            "defaults": {"targetLanguage": "zh"},
        },
        {
            "type": "youdub.export",
            "version": "1.0.0",
            "label": _lt("Export Video & Files", zh="合成与导出", ja="書き出し"),
            "category": "export",
            "providerId": "youdub.media",
            "operation": "media.export/v1",
            "provider": {
                "id": "youdub.media",
                "label": _lt("FFmpeg Media", zh="本地媒体处理", ja="FFmpeg メディア"),
                "operations": [{"id": "media.export/v1"}],
                "execution": "local",
                "ready": True,
                "available": True,
                "models": [],
            },
            "inputs": [
                {
                    "id": "video",
                    "label": _lt("Video", zh="视频", ja="動画"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["file/v1", "video/mp4/v1"],
                    "required": False,
                },
                {
                    "id": "mediaInfo",
                    "label": _lt("Media info", zh="媒体信息", ja="メディア情報"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.mediaInfo/v1"],
                    "required": True,
                },
                {
                    "id": "transcript",
                    "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.transcript/v1"],
                    "required": True,
                },
                {
                    "id": "translation",
                    "label": _lt("Translation", zh="译文文稿", ja="翻訳文"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.translation/v1"],
                    "required": True,
                },
                {
                    "id": "finalAudio",
                    "label": _lt("Mixed audio", zh="混合音轨", ja="ミックス音声"),
                    "kind": "artifact",
                    "acceptedSchemaIds": ["audio/wav/v1"],
                    "required": False,
                },
                {
                    "id": "dubbedTimeline",
                    "label": _lt("Dubbed timeline", zh="配音时间线", ja="吹替タイムライン"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.dubbedTimeline/v1"],
                    "required": False,
                },
                {
                    "id": "alignedSubtitles",
                    "label": _lt("Aligned subtitles", zh="对齐字幕", ja="調整済み字幕"),
                    "kind": "json",
                    "acceptedSchemaIds": ["youdub.alignedSubtitles/v1"],
                    "required": False,
                },
            ],
            "outputs": [
                {
                    "name": "video",
                    "label": _lt("Video", zh="成品视频", ja="動画"),
                    "kind": "artifact",
                    "schemaId": "video/mp4/v1",
                    "required": False,
                },
                {
                    "name": "audio",
                    "label": _lt("Audio", zh="配音音频", ja="音声"),
                    "kind": "artifact",
                    "schemaId": "audio/wav/v1",
                    "required": False,
                },
                {
                    "name": "sourceSubtitles",
                    "label": _lt("Original subtitles", zh="原文字幕", ja="元の字幕"),
                    "kind": "artifact",
                    "schemaId": "application/x-subrip/v1",
                    "required": False,
                },
                {
                    "name": "translatedSubtitles",
                    "label": _lt("Translated subtitles", zh="译文字幕", ja="翻訳字幕"),
                    "kind": "artifact",
                    "schemaId": "application/x-subrip/v1",
                    "required": False,
                },
            ],
            "configSchema": {
                "type": "object",
                "properties": {
                    "sourceLanguage": {
                        "type": "string",
                        "default": "auto",
                        "x-title": _lt("Source language", zh="源语言", ja="元の言語"),
                        "x-options": [
                            {"value": "auto", "label": _LANG_AUTO},
                            {"value": "en", "label": _LANG_EN},
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    },
                    "targetLanguage": {
                        "type": "string",
                        "default": "zh",
                        "x-title": _lt("Target language", zh="目标语言", ja="翻訳先"),
                        "x-options": [
                            {"value": "zh", "label": _LANG_ZH},
                            {"value": "en", "label": _LANG_EN},
                            {"value": "ja", "label": _LANG_JA},
                        ],
                    },
                    "renderSubtitles": {
                        "type": "boolean",
                        "default": True,
                        "x-title": _lt("Burn subtitles", zh="烧录字幕", ja="字幕を焼き込む"),
                        "x-short-title": _lt("Subtitles", zh="烧录字幕", ja="字幕"),
                    },
                },
            },
            "defaults": {"sourceLanguage": "auto", "targetLanguage": "zh", "renderSubtitles": True},
            "ui": {"quickFields": ["renderSubtitles"]},
        },
    ]


def _translate_node_def(
    *,
    provider_id: str,
    provider_label: str,
    available: bool,
    unavailable_reason: str | None,
    models: list[str],
) -> dict[str, Any]:
    return {
        "type": "youdub.translate",
        "version": "1.0.0",
        "label": _lt("Translate Subtitles", zh="大模型翻译", ja="字幕翻訳"),
        "category": "translation",
        "providerId": provider_id,
        "operation": "text.translate/v1",
        "provider": {
            "id": provider_id,
            "label": provider_label,
            "capability": "translation",
            "operations": [{"id": "text.translate/v1"}],
            "execution": "remote",
            "ready": available,
            "available": available,
            **({"unavailableReason": unavailable_reason} if unavailable_reason else {}),
            "models": models,
        },
        "inputs": [
            {
                "id": "transcript",
                "label": _lt("Transcript", zh="识别文稿", ja="文字起こし"),
                "kind": "json",
                "acceptedSchemaIds": ["youdub.transcript/v1"],
                "required": True,
            }
        ],
        "outputs": [
            {
                "name": "translation",
                "label": _lt("Translation", zh="译文文稿", ja="翻訳文"),
                "kind": "json",
                "schemaId": "youdub.translation/v1",
                "required": True,
            }
        ],
        "configSchema": {
            "type": "object",
            "properties": {
                "sourceLanguage": {
                    "type": "string",
                    "default": "auto",
                    "x-title": _lt("Source language", zh="源语言", ja="元の言語"),
                    "x-options": [
                        {"value": "auto", "label": _LANG_AUTO},
                        {"value": "en", "label": _LANG_EN},
                        {"value": "zh", "label": _LANG_ZH},
                        {"value": "ja", "label": _LANG_JA},
                    ],
                },
                "targetLanguage": {
                    "type": "string",
                    "default": "zh",
                    "x-title": _lt("Target language", zh="译文语言", ja="翻訳先"),
                    "x-short-title": _lt("Target", zh="译文语言", ja="翻訳先"),
                    "x-optionsFrom": "target_languages",
                    "x-options": [
                        {"value": "zh", "label": _LANG_ZH},
                        {"value": "en", "label": _LANG_EN},
                        {"value": "ja", "label": _LANG_JA},
                    ],
                },
                "maxCompletionTokens": {
                    "type": "integer",
                    "minimum": 64,
                    "maximum": 32768,
                    "x-title": _lt("Max completion tokens", zh="最大输出 Token", ja="最大出力トークン"),
                },
            },
        },
        "defaults": {"sourceLanguage": "auto", "targetLanguage": "zh"},
        "ui": {"quickFields": ["targetLanguage"]},
        "corrections": {"outputPorts": ["translation"], "schemaIds": ["youdub.translation/v1"]},
    }


def builtin_workflow_templates() -> list[dict[str, Any]]:
    """Return the built-in DAG workflow templates (defaulting Whisper to large-v3-turbo)."""
    video_input = {
        "id": "video",
        "label": "视频",
        "required": True,
        "kind": "artifact",
        "schemaId": "file/v1",
        "acceptedMimeTypes": ["video/*"],
    }

    subtitles_doc = {
        "format": "youdub.workflow",
        "formatVersion": 1,
        "id": "youdub.subtitles",
        "title": "字幕翻译",
        "nodes": [
            {"id": "prepare", "type": "youdub.prepare", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {}, "autoContinue": True},
            {"id": "recognize", "type": "youdub.transcribe", "typeVersion": "1.0.0", "provider": {"id": "whisper", "model": "large-v3-turbo", "device": "auto"}, "config": {"sourceLanguage": "auto"}, "autoContinue": False},
            {"id": "translate", "type": "youdub.translate", "typeVersion": "1.0.0", "provider": {"id": "openai"}, "config": {"sourceLanguage": "auto", "targetLanguage": "zh"}, "autoContinue": False},
            {"id": "export", "type": "youdub.export", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {"sourceLanguage": "auto", "targetLanguage": "zh", "renderSubtitles": True}, "autoContinue": True},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "$inputs", "portId": "video"}, "target": {"nodeId": "prepare", "portId": "video"}},
            {"id": "e2", "source": {"nodeId": "prepare", "portId": "sourceAudio"}, "target": {"nodeId": "recognize", "portId": "audio"}},
            {"id": "e3", "source": {"nodeId": "prepare", "portId": "mediaInfo"}, "target": {"nodeId": "recognize", "portId": "mediaInfo"}},
            {"id": "e4", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "translate", "portId": "transcript"}},
            {"id": "e5", "source": {"nodeId": "$inputs", "portId": "video"}, "target": {"nodeId": "export", "portId": "video"}},
            {"id": "e6", "source": {"nodeId": "prepare", "portId": "mediaInfo"}, "target": {"nodeId": "export", "portId": "mediaInfo"}},
            {"id": "e7", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "export", "portId": "transcript"}},
            {"id": "e8", "source": {"nodeId": "translate", "portId": "translation"}, "target": {"nodeId": "export", "portId": "translation"}},
        ],
        "inputs": [video_input],
        "outputs": [
            {"id": "video", "label": "视频", "kind": "artifact", "schemaId": "video/mp4/v1", "required": True, "source": {"nodeId": "export", "portId": "video"}},
            {"id": "source-subtitles", "label": "原文字幕", "kind": "artifact", "schemaId": "application/x-subrip/v1", "required": True, "source": {"nodeId": "export", "portId": "sourceSubtitles"}},
            {"id": "translated-subtitles", "label": "译文字幕", "kind": "artifact", "schemaId": "application/x-subrip/v1", "required": True, "source": {"nodeId": "export", "portId": "translatedSubtitles"}},
        ],
        "presentation": {
            "positions": {
                "$inputs": {"x": 0, "y": 120},
                "prepare": {"x": 320, "y": 120},
                "recognize": {"x": 640, "y": 120},
                "translate": {"x": 960, "y": 120},
                "export": {"x": 1280, "y": 120},
                "$outputs": {"x": 1600, "y": 120},
            },
            "viewport": {"x": 40, "y": 40, "zoom": 0.75},
        },
    }

    dubbing_doc = {
        "format": "youdub.workflow",
        "formatVersion": 1,
        "id": "youdub.dubbing",
        "title": "视频配音",
        "nodes": [
            {"id": "prepare", "type": "youdub.prepare", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {}, "autoContinue": True},
            {"id": "separate", "type": "youdub.separate", "typeVersion": "1.0.0", "provider": {"id": "demucs", "model": "htdemucs", "device": "auto"}, "config": {}, "autoContinue": True},
            {"id": "recognize", "type": "youdub.transcribe", "typeVersion": "1.0.0", "provider": {"id": "whisper", "model": "large-v3-turbo", "device": "auto"}, "config": {"sourceLanguage": "auto"}, "autoContinue": True},
            {"id": "translate", "type": "youdub.translate", "typeVersion": "1.0.0", "provider": {"id": "openai"}, "config": {"sourceLanguage": "auto", "targetLanguage": "zh"}, "autoContinue": True},
            {"id": "reference", "type": "youdub.reference", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {}, "autoContinue": True},
            {"id": "synthesize", "type": "youdub.synthesize", "typeVersion": "1.0.0", "provider": {"id": "voxcpm", "model": "VoxCPM2", "device": "auto"}, "config": {"targetLanguage": "zh", "voice": {"mode": "source_clone"}}, "autoContinue": True},
            {"id": "mix", "type": "youdub.mix", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {"keepBackground": True}, "autoContinue": True},
            {"id": "export", "type": "youdub.export", "typeVersion": "1.0.0", "provider": {"id": "youdub.media"}, "config": {"sourceLanguage": "auto", "targetLanguage": "zh", "renderSubtitles": False}, "autoContinue": True},
        ],
        "edges": [
            {"id": "d1", "source": {"nodeId": "$inputs", "portId": "video"}, "target": {"nodeId": "prepare", "portId": "video"}},
            {"id": "d2", "source": {"nodeId": "prepare", "portId": "sourceAudio"}, "target": {"nodeId": "separate", "portId": "sourceAudio"}},
            {"id": "d3", "source": {"nodeId": "separate", "portId": "vocals"}, "target": {"nodeId": "recognize", "portId": "audio"}},
            {"id": "d4", "source": {"nodeId": "prepare", "portId": "mediaInfo"}, "target": {"nodeId": "recognize", "portId": "mediaInfo"}},
            {"id": "d5", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "translate", "portId": "transcript"}},
            {"id": "d6", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "reference", "portId": "transcript"}},
            {"id": "d7", "source": {"nodeId": "separate", "portId": "vocals"}, "target": {"nodeId": "reference", "portId": "audio"}},
            {"id": "d8", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "synthesize", "portId": "transcript"}},
            {"id": "d9", "source": {"nodeId": "translate", "portId": "translation"}, "target": {"nodeId": "synthesize", "portId": "translation"}},
            {"id": "d10", "source": {"nodeId": "reference", "portId": "references"}, "target": {"nodeId": "synthesize", "portId": "references"}},
            {"id": "d11", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "mix", "portId": "transcript"}},
            {"id": "d12", "source": {"nodeId": "synthesize", "portId": "speechAudio"}, "target": {"nodeId": "mix", "portId": "speechAudio"}},
            {"id": "d13", "source": {"nodeId": "prepare", "portId": "mediaInfo"}, "target": {"nodeId": "mix", "portId": "mediaInfo"}},
            {"id": "d14", "source": {"nodeId": "separate", "portId": "background"}, "target": {"nodeId": "mix", "portId": "background"}},
            {"id": "d15", "source": {"nodeId": "$inputs", "portId": "video"}, "target": {"nodeId": "export", "portId": "video"}},
            {"id": "d16", "source": {"nodeId": "prepare", "portId": "mediaInfo"}, "target": {"nodeId": "export", "portId": "mediaInfo"}},
            {"id": "d17", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "export", "portId": "transcript"}},
            {"id": "d18", "source": {"nodeId": "translate", "portId": "translation"}, "target": {"nodeId": "export", "portId": "translation"}},
            {"id": "d19", "source": {"nodeId": "mix", "portId": "finalAudio"}, "target": {"nodeId": "export", "portId": "finalAudio"}},
            {"id": "d20", "source": {"nodeId": "mix", "portId": "dubbedTimeline"}, "target": {"nodeId": "export", "portId": "dubbedTimeline"}},
        ],
        "inputs": [video_input],
        "outputs": [
            {"id": "video", "label": "配音视频", "kind": "artifact", "schemaId": "video/mp4/v1", "required": True, "source": {"nodeId": "export", "portId": "video"}},
            {"id": "audio", "label": "配音音频", "kind": "artifact", "schemaId": "audio/wav/v1", "required": True, "source": {"nodeId": "export", "portId": "audio"}},
        ],
        "presentation": {
            "positions": {
                "$inputs": {"x": 0, "y": 120},
                "prepare": {"x": 320, "y": 120},
                "separate": {"x": 640, "y": 120},
                "recognize": {"x": 960, "y": 120},
                "translate": {"x": 1280, "y": 0},
                "reference": {"x": 1280, "y": 340},
                "synthesize": {"x": 1600, "y": 120},
                "mix": {"x": 1920, "y": 120},
                "export": {"x": 2240, "y": 120},
                "$outputs": {"x": 2560, "y": 120},
            },
            "viewport": {"x": 40, "y": 40, "zoom": 0.5},
        },
    }

    both_doc = copy.deepcopy(dubbing_doc)
    both_doc["id"] = "youdub.subtitles-dubbing"
    both_doc["title"] = "字幕＋配音"
    for node in both_doc["nodes"]:
        if node["id"] in {"recognize", "translate"}:
            node["autoContinue"] = False
        if node["id"] == "export":
            node["config"]["renderSubtitles"] = True
    both_doc["nodes"].insert(
        7,
        {
            "id": "align",
            "type": "youdub.align",
            "typeVersion": "1.0.0",
            "provider": {"id": "qwen", "model": "Qwen3-ForcedAligner-0.6B-hf", "device": "auto"},
            "config": {"targetLanguage": "zh"},
            "autoContinue": True,
        },
    )
    both_doc["edges"].extend(
        [
            {"id": "b1", "source": {"nodeId": "synthesize", "portId": "speechAudio"}, "target": {"nodeId": "align", "portId": "speechAudio"}},
            {"id": "b2", "source": {"nodeId": "mix", "portId": "dubbedTimeline"}, "target": {"nodeId": "align", "portId": "dubbedTimeline"}},
            {"id": "b3", "source": {"nodeId": "recognize", "portId": "transcript"}, "target": {"nodeId": "align", "portId": "transcript"}},
            {"id": "b4", "source": {"nodeId": "translate", "portId": "translation"}, "target": {"nodeId": "align", "portId": "translation"}},
            {"id": "b5", "source": {"nodeId": "align", "portId": "alignedSubtitles"}, "target": {"nodeId": "export", "portId": "alignedSubtitles"}},
        ]
    )
    both_doc["outputs"].extend(
        [
            {"id": "source-subtitles", "label": "原文字幕", "kind": "artifact", "schemaId": "application/x-subrip/v1", "required": True, "source": {"nodeId": "export", "portId": "sourceSubtitles"}},
            {"id": "translated-subtitles", "label": "译文字幕", "kind": "artifact", "schemaId": "application/x-subrip/v1", "required": True, "source": {"nodeId": "export", "portId": "translatedSubtitles"}},
        ]
    )
    both_doc["presentation"]["positions"]["mix"] = {"x": 1940, "y": 40}
    both_doc["presentation"]["positions"]["align"] = {"x": 2280, "y": 280}
    both_doc["presentation"]["positions"]["export"] = {"x": 2640, "y": 120}
    both_doc["presentation"]["positions"]["$outputs"] = {"x": 3000, "y": 120}

    def audio_variant(base: dict[str, Any], template_id: str, title: str) -> dict[str, Any]:
        doc = copy.deepcopy(base)
        doc["id"] = template_id
        doc["title"] = title
        doc["inputs"] = [{
            "id": "audio", "label": "音频", "required": True, "kind": "artifact",
            "schemaId": "audio/file/v1", "acceptedMimeTypes": ["audio/*"],
        }]
        doc["edges"] = [edge for edge in doc["edges"] if edge["target"] != {"nodeId": "export", "portId": "video"}]
        for edge in doc["edges"]:
            if edge["source"] == {"nodeId": "$inputs", "portId": "video"}:
                edge["source"]["portId"] = "audio"
        doc["outputs"] = [output for output in doc["outputs"] if output["id"] != "video"]
        return doc

    return [
        subtitles_doc, dubbing_doc, both_doc,
        audio_variant(subtitles_doc, "youdub.audio-subtitles", "音频字幕"),
        audio_variant(dubbing_doc, "youdub.audio-dubbing", "音频配音"),
    ]


def validate_workflow_document(
    document: dict[str, Any],
    node_types: list[dict[str, Any]],
    runtime_inputs: dict[str, Any] | None = None,
) -> tuple[bool, list[dict[str, Any]], list[str]]:
    """Validate workflow structure, types, ports, and DAG acyclicity; return topological node IDs."""
    diagnostics: list[dict[str, Any]] = []
    if document.get("format") != "youdub.workflow" or document.get("formatVersion") != 1:
        diagnostics.append({"code": "INVALID_FORMAT", "message": "Unsupported workflow format; expected youdub.workflow v1."})
        return False, diagnostics, []

    nodes = document.get("nodes") or []
    edges = document.get("edges") or []
    graph_inputs = {inp["id"]: inp for inp in (document.get("inputs") or []) if isinstance(inp, dict) and inp.get("id")}

    type_map: dict[tuple[str, str, str], dict[str, Any]] = {
        (nt["type"], nt["version"], nt["providerId"]): nt for nt in node_types
    }
    fallback_by_type: dict[tuple[str, str], dict[str, Any]] = {
        (nt["type"], nt["version"]): nt for nt in node_types
    }

    node_map: dict[str, dict[str, Any]] = {}
    node_defs: dict[str, dict[str, Any]] = {}
    for node in nodes:
        nid = str(node.get("id") or "")
        if not nid:
            diagnostics.append({"code": "INVALID_NODE", "message": "Every workflow node must have an id."})
            continue
        if nid in node_map:
            diagnostics.append({"nodeId": nid, "code": "DUPLICATE_NODE", "message": f"Duplicate node id: {nid}"})
            continue
        node_map[nid] = node
        pid = str((node.get("provider") or {}).get("id") or "")
        ndef = type_map.get((node.get("type", ""), node.get("typeVersion", ""), pid))
        if ndef is None and node.get("type") == "youdub.translate":
            ndef = fallback_by_type.get(("youdub.translate", node.get("typeVersion", "")))
        if ndef is None:
            diagnostics.append(
                {
                    "nodeId": nid,
                    "code": "UNKNOWN_NODE_TYPE",
                    "message": f"Unsupported node type {node.get('type')} ({pid}).",
                }
            )
            continue
        node_defs[nid] = ndef
        if runtime_inputs is not None and ndef.get("runtimeInputSchema"):
            req_fields = ndef["runtimeInputSchema"].get("required") or []
            values = runtime_inputs.get(nid) or {}
            for rf in req_fields:
                if not str(values.get(rf) or "").strip():
                    diagnostics.append(
                        {
                            "nodeId": nid,
                            "field": rf,
                            "code": "MISSING_RUNTIME_INPUT",
                            "message": f"Runtime input {rf!r} is required for node {nid}.",
                        }
                    )

    # Check edge validity, port compatibility, and required inputs
    adj: dict[str, list[str]] = {nid: [] for nid in node_map}
    indegree: dict[str, int] = {nid: 0 for nid in node_map}
    wired_inputs: dict[tuple[str, str], dict[str, Any]] = {}

    for edge in edges:
        eid = edge.get("id")
        src = edge.get("source") or {}
        tgt = edge.get("target") or {}
        src_nid, src_port = src.get("nodeId"), src.get("portId")
        tgt_nid, tgt_port = tgt.get("nodeId"), tgt.get("portId")
        if tgt_nid not in node_map:
            diagnostics.append({"edgeId": eid, "code": "INVALID_EDGE", "message": f"Unknown target node {tgt_nid}."})
            continue
        if src_nid == "$inputs":
            ginp = graph_inputs.get(src_port)
            if ginp is None:
                diagnostics.append({"edgeId": eid, "code": "UNKNOWN_PORT", "message": f"Unknown workflow input {src_port}."})
                continue
            out_kind, out_schema = ginp.get("kind", "artifact"), ginp.get("schemaId")
        else:
            if src_nid not in node_map:
                diagnostics.append({"edgeId": eid, "code": "INVALID_EDGE", "message": f"Unknown source node {src_nid}."})
                continue
            sdef = node_defs.get(src_nid)
            sport = next((p for p in (sdef or {}).get("outputs", []) if p["name"] == src_port), None)
            if sdef and sport is None:
                diagnostics.append({"edgeId": eid, "nodeId": src_nid, "portId": src_port, "code": "UNKNOWN_PORT", "message": f"Unknown output port {src_nid}.{src_port}."})
                continue
            out_kind = sport["kind"] if sport else None
            out_schema = sport["schemaId"] if sport else None

        tdef = node_defs.get(tgt_nid)
        tport = next((p for p in (tdef or {}).get("inputs", []) if p["id"] == tgt_port), None)
        if tdef and tport is None:
            diagnostics.append({"edgeId": eid, "nodeId": tgt_nid, "portId": tgt_port, "code": "UNKNOWN_PORT", "message": f"Unknown input port {tgt_nid}.{tgt_port}."})
            continue
        if tport and out_schema and (tport["kind"] != out_kind or out_schema not in tport.get("acceptedSchemaIds", [])):
            diagnostics.append(
                {
                    "edgeId": eid,
                    "nodeId": tgt_nid,
                    "portId": tgt_port,
                    "code": "INCOMPATIBLE_PORTS",
                    "message": f"Port {src_nid}.{src_port} ({out_schema}) cannot connect to {tgt_nid}.{tgt_port}.",
                }
            )
            continue

        if (tgt_nid, tgt_port) in wired_inputs:
            diagnostics.append({"edgeId": eid, "nodeId": tgt_nid, "portId": tgt_port, "code": "DUPLICATE_INPUT_EDGE", "message": f"Multiple edges connect to {tgt_nid}.{tgt_port}."})
            continue
        wired_inputs[(tgt_nid, tgt_port)] = src
        if src_nid != "$inputs":
            adj[src_nid].append(tgt_nid)
            indegree[tgt_nid] += 1

    for nid, ndef in node_defs.items():
        for inp in ndef.get("inputs", []):
            if inp.get("required") and (nid, inp["id"]) not in wired_inputs:
                diagnostics.append(
                    {
                        "nodeId": nid,
                        "portId": inp["id"],
                        "code": "MISSING_REQUIRED_INPUT",
                        "message": f"Required input {inp['id']} on node {nid} is not connected.",
                    }
                )

    for g_out in document.get("outputs") or []:
        src = g_out.get("source") or {}
        src_nid = src.get("nodeId")
        if src_nid != "$inputs" and src_nid not in node_map:
            diagnostics.append({"code": "INVALID_OUTPUT", "message": f"Workflow output references unknown node {src_nid}."})

    # Topological sort (Kahn) preserving definition order for determinism
    order_index = {node["id"]: idx for idx, node in enumerate(nodes) if node.get("id") in node_map}
    queue = deque(sorted([nid for nid, deg in indegree.items() if deg == 0], key=lambda x: order_index[x]))
    topo: list[str] = []
    while queue:
        cur = queue.popleft()
        topo.append(cur)
        for nxt in sorted(adj[cur], key=lambda x: order_index[x]):
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)

    if len(topo) != len(node_map):
        diagnostics.append({"code": "CYCLE_DETECTED", "message": "Workflow graph contains a cycle and cannot execute."})

    return len(diagnostics) == 0, diagnostics, topo
