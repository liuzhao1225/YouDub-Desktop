"""Media inspection and cancellable subprocess execution for operations."""

from __future__ import annotations

import json
import math
import queue
import subprocess
import threading
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from typing import Any

from ..config import ffmpeg_binary, ffprobe_binary
from .errors import ApiError


def _invalid(message: str) -> ApiError:
    return ApiError(422, "INVALID_MEDIA", message, field="file", stage="prepare", action="none")


def _run_media(
    command: list[str], *, check_cancel: Callable[[], None],
    cwd: Path | None = None,
    on_stdout_line: Callable[[str], None] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Poll cancellation while draining process output, and always reap it."""
    check_cancel()
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd) as process:
        if on_stdout_line is None:
            try:
                while True:
                    check_cancel()
                    try:
                        stdout, stderr = process.communicate(timeout=0.1)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                check_cancel()
            except BaseException:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                raise
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)

        stdout_lines: list[str] = []
        stderr_chunks: list[str] = []
        line_queue: queue.Queue[str | None] = queue.Queue()

        def _read_stdout() -> None:
            assert process.stdout is not None
            try:
                for line in iter(process.stdout.readline, ""):
                    stdout_lines.append(line)
                    line_queue.put(line)
            except ValueError:
                pass
            finally:
                line_queue.put(None)

        def _read_stderr() -> None:
            assert process.stderr is not None
            try:
                stderr_chunks.append(process.stderr.read())
            except ValueError:
                pass

        out_thread = threading.Thread(target=_read_stdout, daemon=True)
        err_thread = threading.Thread(target=_read_stderr, daemon=True)
        out_thread.start()
        err_thread.start()
        try:
            stdout_eof = False
            while not stdout_eof or process.poll() is None:
                check_cancel()
                try:
                    item = line_queue.get(timeout=0.05)
                    while True:
                        if item is None:
                            stdout_eof = True
                        else:
                            on_stdout_line(item.rstrip("\r\n"))
                        try:
                            item = line_queue.get_nowait()
                        except queue.Empty:
                            break
                except queue.Empty:
                    pass
            process.wait()
            out_thread.join(timeout=2)
            err_thread.join(timeout=2)
            check_cancel()
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            out_thread.join(timeout=1)
            err_thread.join(timeout=1)
            raise
        return subprocess.CompletedProcess(command, process.returncode, "".join(stdout_lines), "".join(stderr_chunks))


def _probe(path: Path, check_cancel: Callable[[], None]) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        raise _invalid("The input media file is missing or empty.")
    try:
        result = _run_media(
            [ffprobe_binary(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path.resolve())],
            check_cancel=check_cancel,
        )
    except FileNotFoundError as exc:
        raise ApiError(503, "RUNTIME_UNAVAILABLE", "ffprobe is unavailable.", stage="prepare") from exc
    if result.returncode != 0:
        raise _invalid("ffprobe could not read the input media.")
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise _invalid("ffprobe returned invalid media information.") from exc
    if not isinstance(data, dict):
        raise _invalid("ffprobe returned invalid media information.")
    return data


def _positive_number(value: Any) -> float | None:
    try:
        number = float(Fraction(str(value)))
    except (ValueError, ZeroDivisionError, OverflowError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _duration_ms(data: dict[str, Any], stream: dict[str, Any]) -> int:
    # MP4 commonly exposes stream duration; Matroska commonly exposes only the
    # container duration. Prefer the selected stream when it is available.
    seconds = _positive_number(stream.get("duration"))
    if seconds is None:
        container = data.get("format")
        seconds = _positive_number(container.get("duration")) if isinstance(container, dict) else None
    if seconds is None:
        raise _invalid("The media duration is missing or invalid.")
    return max(1, round(seconds * 1000))


def _stream_start_ms(stream: dict[str, Any]) -> int:
    if "start_time" not in stream:
        return 0
    try:
        seconds = float(Fraction(str(stream["start_time"])))
        if not math.isfinite(seconds):
            raise ValueError("Non-finite start time")
        return round(seconds * 1000)
    except (ValueError, ZeroDivisionError, OverflowError) as exc:
        raise _invalid("The first video or audio stream start time is invalid.") from exc


def inspect_video(
    path: Path, check_cancel: Callable[[], None], *, allow_audio_only: bool = False,
) -> dict[str, Any]:
    """Inspect the first video and audio streams, ignoring cover art in audio-only mode.

    The importer owns file-name and byte-count admission. This function also
    works for a temporary upload path without the original file extension.
    """
    data = _probe(path, check_cancel=check_cancel)
    streams = data.get("streams")
    if not isinstance(streams, list) or any(not isinstance(stream, dict) for stream in streams):
        raise _invalid("The media stream information is invalid.")
    first_video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    video = (
        first_video
        if first_video is not None and (first_video.get("disposition") or {}).get("attached_pic") != 1
        else None
    )
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if video is None and not allow_audio_only:
        raise _invalid("The input has no usable first video stream.")
    if audio is None:
        raise ApiError(422, "NO_AUDIO_TRACK", "The input video has no audio track.",
                       field="file", stage="prepare", action="none")
    if video is None:
        _stream_start_ms(audio)
        return {"duration_ms": _duration_ms(data, audio), "audio_codec": audio.get("codec_name")}
    if _stream_start_ms(video) != _stream_start_ms(audio):
        raise ApiError(415, "UNSUPPORTED_MEDIA", "Different video and audio start times are not supported.",
                       field="file", stage="prepare", action="none")
    width, height = video.get("width"), video.get("height")
    frame_rate = _positive_number(video.get("avg_frame_rate")) or _positive_number(video.get("r_frame_rate"))
    if (type(width) is not int or type(height) is not int or width <= 0 or height <= 0 or frame_rate is None):
        raise _invalid("The video dimensions or frame rate are invalid.")
    duration_ms = _duration_ms(data, video)
    info = {"duration_ms": duration_ms, "width": width, "height": height, "frame_rate": frame_rate,
            "video_codec": video.get("codec_name"), "audio_codec": audio.get("codec_name")}
    return info


def prepare_media(
    video: Path,
    work_dir: Path,
    check_cancel: Callable[[], None],
    progress: Callable[[float | None, str], None] | None = None,
) -> tuple[dict[str, Any], Path, Path]:
    """Inspect source media and extract canonical 44.1 kHz stereo PCM audio."""
    check_cancel()
    info = inspect_video(video, check_cancel, allow_audio_only=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    source_audio = work_dir / "sourceAudio.wav"
    media_json = work_dir / "media.json"
    if progress:
        progress(None, "Extracting source audio")
    try:
        result = _run_media([
            ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
            "-i", str(video.resolve()), "-map", "0:a:0", "-vn",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(source_audio.resolve()),
        ], check_cancel=check_cancel)
    except FileNotFoundError as exc:
        raise ApiError(503, "RUNTIME_UNAVAILABLE", "ffmpeg is unavailable.", stage="prepare") from exc
    if result.returncode != 0:
        if source_audio.exists():
            source_audio.unlink()
        raise ApiError(422, "INVALID_MEDIA", "Source audio extraction failed.", field="file", stage="prepare")
    media_json.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    return info, source_audio, media_json
