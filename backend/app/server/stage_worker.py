"""Isolated subprocess runner for heavy local media/ML stages.

Running Whisper, Demucs, VoxCPM2, Qwen3-ForcedAligner, and FFmpeg stages inside a
fresh child process guarantees GPU/MPS VRAM is released after each node finishes and
allows instant OS process-group termination on task cancellation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ..accelerators import detect_devices
from ..config import ffmpeg_binary
from ..v1 import asr, export, forced_alignment, media, mix, separate, tts
from ..v1.contracts import TaskConfig
from ..v1.errors import ApiError
from ..v1.segments import read_transcript, read_translation
from ..v1.steps import StageContext
from .errors import AppError
from .video_download import download_audio, download_video


def _resolve_device(requested: str | None, *, allow_mps: bool) -> str:
    if requested and requested != "auto":
        return requested
    available = [d["id"] for d in detect_devices() if d.get("available")]
    for candidate in available:
        if candidate.startswith("cuda:"):
            return candidate
    if allow_mps and "mps" in available:
        return "mps"
    return "cpu"


def _progress(ratio: float | None, message: str) -> None:
    print(json.dumps({"event": "progress", "progress": ratio, "message": message}, ensure_ascii=False), flush=True)


def _noop_cancel() -> None:
    return None


def _base_task_config(spec: dict[str, Any]) -> TaskConfig:
    cfg = spec.get("config") or {}
    provider = spec.get("provider") or {}
    operation = spec["operation"]
    src_lang = str(cfg.get("sourceLanguage") or "auto")
    if src_lang == "auto":
        src_lang = "en"
    tgt_lang = str(cfg.get("targetLanguage") or "zh")
    if tgt_lang == "auto":
        tgt_lang = "zh"

    has_dubbing = bool(spec.get("hasDubbing"))
    has_subtitles = bool(spec.get("hasSubtitles", True))
    output_mode = "both" if (has_dubbing and has_subtitles) else "dubbing" if has_dubbing else "subtitles"

    asr_model = str(provider.get("model") if operation == "speech.transcribe/v1" else "tiny")
    asr_device = _resolve_device(provider.get("device") if operation == "speech.transcribe/v1" else "cpu", allow_mps=False)
    tts_device = _resolve_device(provider.get("device") if operation in {"speech.synthesize/v1", "speech.reference/v1"} else "cpu", allow_mps=True)
    sep_device = _resolve_device(provider.get("device") if operation == "audio.separate/v1" else "cpu", allow_mps=True)
    align_device = _resolve_device(provider.get("device") if operation == "subtitles.align/v1" else "cpu", allow_mps=True)

    keep_bg = bool(cfg.get("keepBackground", True)) if has_dubbing else False
    voice_cfg = cfg.get("voice") if isinstance(cfg.get("voice"), dict) else {"mode": "source_clone"}
    need_sep = has_dubbing and (keep_bg or voice_cfg.get("mode") == "source_clone")

    payload: dict[str, Any] = {
        "source_language": "auto" if cfg.get("sourceLanguage") == "auto" else src_lang,
        "target_language": tgt_lang,
        "output_mode": output_mode,
        "keep_background": keep_bg,
        "asr": {
            "adapter": "whisper",
            "model": asr_model,
            "device": asr_device,
            **({"initial_prompt": cfg["initialPrompt"]} if cfg.get("initialPrompt") else {}),
        },
        "translation": {"adapter": "openai", "model": "configured", "device": "remote"},
        "tts": (
            {"adapter": "voxcpm", "model": "VoxCPM2", "device": tts_device, "voice": voice_cfg}
            if has_dubbing
            else None
        ),
        "separation": (
            {"adapter": "demucs", "model": "htdemucs", "device": sep_device}
            if need_sep
            else None
        ),
        "subtitle_alignment": (
            {"adapter": "qwen_forced_aligner", "model": "Qwen3-ForcedAligner-0.6B-hf", "device": align_device}
            if output_mode == "both" and operation == "subtitles.align/v1" and tgt_lang in {"zh", "en"}
            else None
        ),
    }
    return TaskConfig.model_validate(payload)


def execute_spec(spec: dict[str, Any]) -> dict[str, Any]:
    op = spec["operation"]
    work_dir = Path(spec["workDir"]).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    raw_inputs: dict[str, str] = spec.get("inputFiles") or {}
    input_files = {k: Path(v).resolve() for k, v in raw_inputs.items() if v}
    cfg = spec.get("config") or {}

    if op in {"video.download/v1", "audio.download/v1"}:
        port, download = ("audio", download_audio) if op == "audio.download/v1" else ("video", download_video)
        url = str(spec.get("url") or "")
        proxy_port = int(cfg.get("proxyPort") or 0)
        proxy_url = str(spec.get("proxyUrl") or "")
        ffmpeg_loc = spec.get("ffmpegLocation")
        cookiefile = spec.get("cookiefile")
        media_path, meta = download(
            url,
            work_dir,
            proxy_port=proxy_port,
            proxy_url=proxy_url,
            ffmpeg_location=ffmpeg_loc,
            cookiefile=str(cookiefile) if cookiefile else None,
            check_cancel=_noop_cancel,
            progress=_progress,
        )
        artifacts = {port: str(media_path.resolve())}
        if op == "video.download/v1" and isinstance(meta, dict) and "coverPath" in meta:
            cover_path = meta.pop("coverPath")
            if cover_path and Path(cover_path).is_file():
                artifacts["cover"] = str(Path(cover_path).resolve())
        return {
            "artifacts": artifacts,
            "outputs": {"metadata": meta},
        }

    task_cfg = _base_task_config(spec)

    if op == "media.prepare/v1":
        info, source_audio, _ = media.prepare_media(
            input_files["video"], work_dir, _noop_cancel, _progress
        )
        return {
            "artifacts": {"sourceAudio": str(source_audio)},
            "outputs": {"mediaInfo": info},
        }

    if op == "audio.separate/v1":
        # Support both sourceAudio (from prepare) and video (v1 default) cleanly.
        if "sourceAudio" in input_files and "video" not in input_files:
            import soundfile as sf

            src_wav = input_files["sourceAudio"]
            directory = work_dir / "separation"
            directory.mkdir(parents=True, exist_ok=True)
            prepared_source = directory / "source.wav"
            vocals, background = directory / "vocals.wav", directory / "background.wav"
            res = media._run_media(
                [
                    ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
                    "-i", str(src_wav), "-map", "0:a:0", "-vn", "-ar", "44100", "-ac", "2",
                    "-c:a", "pcm_f32le", str(prepared_source),
                ],
                check_cancel=_noop_cancel,
            )
            if res.returncode:
                raise ApiError(500, "INVALID_MEDIA", "Source audio preparation failed.", stage="separate")
            model_file = separate.model_directory() / separate.MODEL_FILES["htdemucs"]
            if not model_file.is_file() or model_file.stat().st_size == 0:
                raise ApiError(503, "MODEL_NOT_READY", "Demucs htdemucs checkpoint is missing.", stage="separate")
            _progress(None, "Separating vocals and background with Demucs")
            run_res = media._run_media(
                [
                    sys.executable,
                    str(Path(separate.__file__).with_name("separate_process.py")),
                    "--model-path", str(model_file.resolve()),
                    "--audio-path", str(prepared_source),
                    "--vocals-path", str(vocals),
                    "--background-path", str(background),
                    "--device", task_cfg.separation.device if task_cfg.separation else "cpu",
                ],
                check_cancel=_noop_cancel,
            )
            if run_res.returncode:
                raise ApiError(500, "WORKER_EXITED", f"Demucs process failed: {run_res.stderr[-500:]}", stage="separate")
            orig = sf.info(prepared_source)
            for out_p in (vocals, background):
                oi = sf.info(out_p)
                if oi.frames != orig.frames:
                    raise ApiError(502, "INVALID_PROVIDER_RESULT", "Separated audio changed duration.", stage="separate")
            return {"artifacts": {"vocals": str(vocals), "background": str(background)}, "outputs": {}}
        ctx = StageContext(stage="separate", config=task_cfg, input_files=input_files, work_dir=work_dir, check_cancel=_noop_cancel)
        completed = separate.run(ctx, _progress)
        return {"artifacts": {k: str(v) for k, v in completed.output_files.items()}, "outputs": {}}

    if op == "speech.transcribe/v1":
        from .whisper_resegment import resegment_whisper

        audio_path = input_files.get("audio") or input_files.get("vocals") or input_files.get("source_audio")
        ctx_files = {"source_audio": audio_path}
        if "mediaInfo" in input_files:
            ctx_files["media_info"] = input_files["mediaInfo"]
        ctx = StageContext(stage="asr", config=task_cfg, input_files=ctx_files, work_dir=work_dir, check_cancel=_noop_cancel)
        completed = asr.run(ctx, _progress)
        raw = json.loads(completed.output_files["asr_raw"].read_text(encoding="utf-8"))
        transcript = json.loads(completed.output_files["transcript"].read_text(encoding="utf-8"))
        resegmented = resegment_whisper(str(raw.get("text") or ""), transcript)
        return {"artifacts": {"asr_raw": str(completed.output_files["asr_raw"])}, "outputs": {"transcript": resegmented}}

    if op == "speech.reference/v1":
        vocals_path = input_files.get("audio") or input_files.get("vocals")
        transcript_path = input_files["transcript"]
        transcript_obj = read_transcript(transcript_path, stage="tts")
        ctx = StageContext(stage="tts", config=task_cfg, input_files={"vocals": vocals_path}, work_dir=work_dir, check_cancel=_noop_cancel)
        refs = tts.prepare_reference_audio(ctx, transcript_obj, _progress)
        serializable = {k: {"path": str(v["path"]), "text": v["text"]} for k, v in refs.items()}
        return {"artifacts": {}, "outputs": {"references": serializable}}

    if op == "speech.synthesize/v1":
        refs_raw = json.loads(input_files["references"].read_text(encoding="utf-8"))
        prepared_refs = {k: {"path": Path(v["path"]), "text": v["text"]} for k, v in refs_raw.items()}
        ctx = StageContext(
            stage="tts",
            config=task_cfg,
            input_files={"transcript": input_files["transcript"], "translation": input_files["translation"]},
            work_dir=work_dir,
            check_cancel=_noop_cancel,
        )
        completed = tts.run(ctx, _progress, prepared_references=prepared_refs)
        clips_data = json.loads(completed.output_files["speech_clips"].read_text(encoding="utf-8"))
        # Expose speechAudio matching TaskNodeDetail viewer + retain internal speechClips path
        segments = []
        for idx, c in enumerate(clips_data["clips"], start=1):
            abs_clip = (work_dir / c["path"]).resolve()
            segments.append(
                {
                    "id": c["segment_id"],
                    "durationMs": c["duration_ms"],
                    "sampleRate": c["sample_rate_hz"],
                    "channels": c["channels"],
                    "artifactPath": str(abs_clip),
                    "artifactId": f"speech-{idx:06d}",
                }
            )
        return {
            "artifacts": {"speech_clips": str(completed.output_files["speech_clips"])},
            "outputs": {"speechAudio": {"workDir": str(work_dir), "clips": clips_data["clips"], "segments": segments}},
        }

    if op == "audio.mix/v1":
        speech_clips_json = work_dir / "speech_clips_input.json"
        speech_payload = json.loads(input_files["speechAudio"].read_text(encoding="utf-8"))
        speech_work_dir = Path(speech_payload["workDir"]).resolve() if speech_payload.get("workDir") else work_dir
        override_clip_paths: list[str] = list(spec.get("speechClipPaths") or [])
        # Copy/reference clips relative paths neatly into work_dir via hardlinks/symlinks/paths
        clips_for_mix = []
        linked_dir = work_dir / "tts_linked"
        linked_dir.mkdir(parents=True, exist_ok=True)
        for idx, clip in enumerate(speech_payload["clips"]):
            src = (
                Path(override_clip_paths[idx]).resolve()
                if idx < len(override_clip_paths) and Path(override_clip_paths[idx]).is_file()
                else (speech_work_dir / clip["path"]).resolve()
            )
            dst = linked_dir / Path(clip["path"]).name
            if not dst.exists():
                try:
                    dst.hardlink_to(src)
                except OSError:
                    import shutil
                    shutil.copy2(src, dst)
            clips_for_mix.append({**clip, "path": dst.relative_to(work_dir).as_posix()})
        speech_clips_json.write_text(json.dumps({"clips": clips_for_mix}, ensure_ascii=False), encoding="utf-8")

        mix_inputs = {
            "transcript": input_files["transcript"],
            "speech_clips": speech_clips_json,
            "media_info": input_files["mediaInfo"],
        }
        if "background" in input_files and bool(cfg.get("keepBackground", True)):
            mix_inputs["background"] = input_files["background"]
        else:
            task_cfg = task_cfg.model_copy(update={"keep_background": False})
        ctx = StageContext(stage="mix", config=task_cfg, input_files=mix_inputs, work_dir=work_dir, check_cancel=_noop_cancel)
        completed = mix.run(ctx, _progress)
        timeline = json.loads(completed.output_files["alignment"].read_text(encoding="utf-8"))
        extra_artifacts = {
            f"adjusted-{idx:04d}": str((work_dir / "adjusted" / f"{idx:04d}.wav").resolve())
            for idx in range(1, len(clips_for_mix) + 1)
            if (work_dir / "adjusted" / f"{idx:04d}.wav").is_file()
        }
        return {
            "artifacts": {"finalAudio": str(completed.output_files["mixed_audio"])},
            "extraArtifacts": extra_artifacts,
            "outputs": {"dubbedTimeline": timeline},
        }

    if op == "subtitles.align/v1":
        transcript_obj = read_transcript(input_files["transcript"], stage="export")
        translation_obj = read_translation(input_files["translation"], transcript_obj, stage="export")
        translations = translation_obj.match(transcript_obj)
        timeline_json = json.loads(input_files["dubbedTimeline"].read_text(encoding="utf-8"))
        aligned_by_id = {seg["segment_id"]: seg for seg in timeline_json["segments"]}

        speech_payload = json.loads(input_files["speechAudio"].read_text(encoding="utf-8")) if "speechAudio" in input_files else None
        override_adjusted: list[str] = list(spec.get("mixAdjustedPaths") or [])
        override_speech: list[str] = list(spec.get("speechClipPaths") or [])
        mix_adjusted_paths: list[Path] = []
        rows = []
        for idx, segment in enumerate(transcript_obj.segments, start=1):
            a = aligned_by_id[segment.id]
            dub_seg = segment.model_copy(update={"start_ms": a["dubbed_start_ms"], "end_ms": a["dubbed_end_ms"]})
            rows.append((dub_seg, translations[segment.id]))
            if idx <= len(override_adjusted) and Path(override_adjusted[idx - 1]).is_file():
                mix_adjusted_paths.append(Path(override_adjusted[idx - 1]).resolve())
            elif "mixWorkDir" in spec and (Path(spec["mixWorkDir"]) / "adjusted" / f"{idx:04d}.wav").is_file():
                mix_adjusted_paths.append((Path(spec["mixWorkDir"]) / "adjusted" / f"{idx:04d}.wav").resolve())
            elif idx <= len(override_speech) and Path(override_speech[idx - 1]).is_file():
                mix_adjusted_paths.append(Path(override_speech[idx - 1]).resolve())
            elif speech_payload:
                cand = Path(speech_payload["workDir"]) / speech_payload["clips"][idx - 1]["path"]
                mix_adjusted_paths.append(cand)

        if task_cfg.target_language in {"en", "zh"}:
            ctx = StageContext(stage="export", config=task_cfg, input_files={}, work_dir=work_dir, check_cancel=_noop_cancel)
            cues = forced_alignment.align(ctx, rows, export._display_parts, _progress, audio_paths=mix_adjusted_paths)
        else:
            _progress(0.5, f"Aligning {task_cfg.target_language} subtitle display intervals to dubbed timeline")
            cues = [
                cue
                for dub_seg, text in rows
                for cue in export._display_cues(text, dub_seg.start_ms, dub_seg.end_ms, task_cfg.target_language)
            ]
            _progress(1.0, "Aligned subtitle intervals are ready")
        return {
            "artifacts": {},
            "outputs": {"alignedSubtitles": {"cues": [{"start_ms": s, "end_ms": e, "text": t} for s, e, t in cues]}},
        }

    if op == "media.export/v1":
        has_dub = "finalAudio" in input_files and "dubbedTimeline" in input_files
        want_subs = bool(cfg.get("renderSubtitles", True)) or bool(spec.get("hasSubtitles", False))
        mode = "both" if (has_dub and want_subs) else "dubbing" if has_dub else "subtitles"
        task_cfg = task_cfg.model_copy(update={"output_mode": mode})
        exp_inputs: dict[str, Path] = {
            "media_info": input_files["mediaInfo"],
            "transcript": input_files["transcript"],
            "translation": input_files["translation"],
        }
        if "video" in input_files:
            exp_inputs["video"] = input_files["video"]
        if has_dub:
            exp_inputs["mixed_audio"] = input_files["finalAudio"]
            exp_inputs["alignment"] = input_files["dubbedTimeline"]
        prepared_cues: list[tuple[int, int, str]] | None = None
        if "alignedSubtitles" in input_files:
            raw_cues = json.loads(input_files["alignedSubtitles"].read_text(encoding="utf-8"))
            prepared_cues = [(c["start_ms"], c["end_ms"], c["text"]) for c in raw_cues["cues"]]
        out_dir = work_dir / "export_out"
        ctx = StageContext(stage="export", config=task_cfg, input_files=exp_inputs, work_dir=work_dir, check_cancel=_noop_cancel)
        completed = export.run(ctx, _progress, output_dir=out_dir, prepared_cues=prepared_cues)
        port_key_map = {
            "source_subtitles": "sourceSubtitles",
            "translated_subtitles": "translatedSubtitles",
        }
        return {
            "artifacts": {port_key_map.get(k, k): str(v) for k, v in completed.output_files.items()},
            "outputs": {},
        }

    raise AppError(400, "UNSUPPORTED_OPERATION", f"Unsupported worker operation: {op}")


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 2:
        print("Usage: python -m backend.app.server.stage_worker <spec.json> <result.json>", file=sys.stderr)
        return 2
    spec_path, result_path = Path(args[0]), Path(args[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    try:
        output = execute_spec(spec)
        result_path.write_text(json.dumps({"ok": True, **output}, ensure_ascii=False), encoding="utf-8")
        return 0
    except AppError as exc:
        result_path.write_text(
            json.dumps({"ok": False, "code": exc.code, "message": exc.message}, ensure_ascii=False),
            encoding="utf-8",
        )
        return 1
    except ApiError as exc:
        err = exc.content.get("error", {})
        result_path.write_text(
            json.dumps({"ok": False, "code": err.get("code", "STAGE_FAILED"), "message": err.get("message", str(exc))}, ensure_ascii=False),
            encoding="utf-8",
        )
        return 1
    except Exception as exc:
        result_path.write_text(
            json.dumps({"ok": False, "code": "STAGE_FAILED", "message": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False),
            encoding="utf-8",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
