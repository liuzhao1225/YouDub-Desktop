"""Safe YouTube/Bilibili URL validation and yt-dlp media downloads."""

from __future__ import annotations

import ipaddress
import os
import re
import shutil
import socket
import subprocess
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from ..v1.errors import ApiError
from .errors import AppError

_ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
    "b23.tv",
}
_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
_THUMBNAIL_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_TEMP_SUFFIXES = {".part", ".ytdl", ".temp"}
_BILIBILI_VIDEO_RE = re.compile(r"^/video/((?:BV[A-Za-z0-9]+|av\d+))/?$", re.IGNORECASE)


def _check_public_host(hostname: str) -> None:
    try:
        addr = ipaddress.ip_address(hostname)
    except ValueError:
        addr = None
    if addr is not None:
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
            raise AppError(422, "INVALID_VIDEO_URL", f"Private or loopback targets are not allowed: {hostname}")
        return
    try:
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except OSError:
        return
    for info in infos:
        raw_ip = info[4][0]
        try:
            resolved = ipaddress.ip_address(raw_ip)
        except ValueError:
            continue
        if resolved.is_private or resolved.is_loopback or resolved.is_link_local or resolved.is_reserved:
            raise AppError(422, "INVALID_VIDEO_URL", f"Blocked redirect or target resolving to private IP: {hostname}")


def video_url(raw: str) -> str:
    """Validate and canonicalize a YouTube or Bilibili single-video URL."""
    text = raw.strip()
    if not text:
        raise AppError(422, "INVALID_VIDEO_URL", "Video URL cannot be empty.")
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise AppError(422, "INVALID_VIDEO_URL", "Only clean HTTP/HTTPS YouTube or Bilibili URLs are supported.")
    if parsed.port is not None:
        raise AppError(422, "INVALID_VIDEO_URL", "Custom ports are not allowed on video URLs.")
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in _ALLOWED_HOSTS:
        raise AppError(422, "INVALID_VIDEO_URL", f"Unsupported video host: {host or '<empty>'}")

    if host == "youtu.be":
        video_id = parsed.path.lstrip("/").split("/", 1)[0]
        if not _YOUTUBE_ID_RE.match(video_id):
            raise AppError(422, "INVALID_VIDEO_URL", "Invalid youtu.be video link.")
        return f"https://www.youtube.com/watch?v={video_id}"

    if host.endswith("youtube.com"):
        if parsed.path.startswith("/playlist"):
            raise AppError(422, "INVALID_VIDEO_URL", "Playlist URLs are not supported; paste a single video link.")
        if parsed.path.startswith("/shorts/"):
            video_id = parsed.path[len("/shorts/") :].split("/", 1)[0]
            if not _YOUTUBE_ID_RE.match(video_id):
                raise AppError(422, "INVALID_VIDEO_URL", "Invalid YouTube Shorts link.")
            return f"https://www.youtube.com/watch?v={video_id}"
        if parsed.path == "/watch":
            params = urllib.parse.parse_qs(parsed.query)
            video_id = (params.get("v") or [""])[0]
            if not _YOUTUBE_ID_RE.match(video_id):
                raise AppError(422, "INVALID_VIDEO_URL", "Invalid YouTube watch URL.")
            return f"https://www.youtube.com/watch?v={video_id}"
        raise AppError(422, "INVALID_VIDEO_URL", "Unsupported YouTube URL path.")

    if host == "b23.tv":
        code = parsed.path.lstrip("/").split("/", 1)[0]
        if not code:
            raise AppError(422, "INVALID_VIDEO_URL", "Invalid b23.tv short link.")
        return f"https://b23.tv/{code}"

    # Bilibili desktop / mobile video links
    path = parsed.path
    if not _BILIBILI_VIDEO_RE.match(path):
        raise AppError(422, "INVALID_VIDEO_URL", "Expected a Bilibili /video/BV... or /video/av... link.")
    params = urllib.parse.parse_qs(parsed.query)
    part = (params.get("p") or [None])[0]
    canonical = f"https://www.bilibili.com{path.rstrip('/')}/"
    if part and part.isdigit():
        canonical = f"{canonical}?p={part}"
    return canonical


class SafeRedirectHandler(HTTPRedirectHandler):
    """Prevents redirects to non-allowed or private-network hosts when resolving b23.tv links."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        validated = video_url(newurl)
        host = urllib.parse.urlsplit(validated).hostname or ""
        _check_public_host(host)
        return super().redirect_request(req, fp, code, msg, headers, validated)


def _validate_proxy_port(proxy_port: Any) -> int:
    if proxy_port in (None, ""):
        return 0
    if isinstance(proxy_port, bool) or not isinstance(proxy_port, int):
        raise AppError(422, "INVALID_CONFIG", "proxyPort must be an integer between 0 and 65535.")
    if proxy_port < 0 or proxy_port > 65535:
        raise AppError(422, "INVALID_CONFIG", "proxyPort must be between 0 and 65535.")
    return proxy_port


def _resolve_proxy(*, proxy_port: Any = 0, proxy_url: str = "") -> str:
    port = _validate_proxy_port(proxy_port)
    if port > 0:
        return f"http://127.0.0.1:{port}"
    return proxy_url.strip()


def _resolve_short_link(url: str, proxy: str) -> str:
    if urllib.parse.urlsplit(url).hostname != "b23.tv":
        return url
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    opener = build_opener(ProxyHandler(proxies), SafeRedirectHandler())
    with opener.open(url, timeout=15) as response:
        resolved = getattr(response, "url", "") or url
    return video_url(resolved)


def _resolve_js_runtimes() -> dict[str, dict[str, str]]:
    """Discover JS runtimes (explicit YOUDUB_NODE_PATH first, then PATH fallback) for yt-dlp EJS."""
    runtimes: dict[str, dict[str, str]] = {}
    env_node = os.getenv("YOUDUB_NODE_PATH", "").strip()
    if env_node and Path(env_node).is_file():
        runtimes["node"] = {"path": str(Path(env_node).resolve())}
    for runtime_name, binary in (("deno", "deno"), ("node", "node"), ("bun", "bun"), ("quickjs", "qjs")):
        if runtime_name in runtimes:
            continue
        found = shutil.which(binary)
        if found and Path(found).is_file():
            runtimes[runtime_name] = {"path": str(Path(found).resolve())}
    return runtimes


def _classify_download_error(exc: Exception, *, has_cookies: bool) -> AppError | None:
    """Map recognizable yt-dlp DownloadError failures to actionable AppError codes while keeping raw text."""
    raw_msg = str(exc).strip() or "Video download failed."
    msg = raw_msg.lower()
    if any(
        token in msg
        for token in (
            "sign in to confirm you",
            "not a bot",
            "use --cookies",
            "confirm your age",
            "login required",
            "members-only",
            "cookies are no longer valid",
            "cookies have been rotated",
        )
    ):
        expired = has_cookies or "cookies are no longer valid" in msg or "cookies have been rotated" in msg
        return AppError(422, "YOUTUBE_COOKIES_EXPIRED" if expired else "YOUTUBE_COOKIES_REQUIRED", raw_msg)
    if any(
        token in msg
        for token in (
            "no video formats found",
            "requested format is not available",
            "n challenge solving failed",
            "signature extraction failed",
        )
    ):
        return AppError(502, "DOWNLOAD_NO_FORMATS", raw_msg)
    if any(
        token in msg
        for token in (
            "video unavailable",
            "this video is unavailable",
            "private video",
            "this video is private",
            "this video has been removed",
            "no longer available",
            "not available in your country",
            "not made this video available",
            "geo-restricted",
            "account associated with this video has been terminated",
        )
    ):
        return AppError(404, "VIDEO_UNAVAILABLE", raw_msg)
    if any(
        token in msg
        for token in (
            "unable to download webpage",
            "cannot connect to proxy",
            "proxy error",
            "timed out",
            "connection reset",
            "connection refused",
            "getaddrinfo",
            "name resolution",
            "ssl:",
            "http error 429",
            "too many requests",
        )
    ):
        return AppError(502, "DOWNLOAD_NETWORK_ERROR", raw_msg)
    return None


def download_video(
    raw_url: str,
    work_dir: Path,
    *,
    proxy_port: Any = 0,
    proxy_url: str = "",
    ffmpeg_location: str | None = None,
    cookiefile: str | None = None,
    check_cancel: Callable[[], None] | None = None,
    progress: Callable[[float | None, str], None] | None = None,
) -> tuple[Path, dict[str, Any]]:
    """Download a validated YouTube or Bilibili video using yt-dlp."""
    return _download_media(
        raw_url, work_dir, audio_only=False, proxy_port=proxy_port, proxy_url=proxy_url,
        ffmpeg_location=ffmpeg_location, cookiefile=cookiefile, check_cancel=check_cancel, progress=progress,
    )


def download_audio(
    raw_url: str,
    work_dir: Path,
    *,
    proxy_port: Any = 0,
    proxy_url: str = "",
    ffmpeg_location: str | None = None,
    cookiefile: str | None = None,
    check_cancel: Callable[[], None] | None = None,
    progress: Callable[[float | None, str], None] | None = None,
) -> tuple[Path, dict[str, Any]]:
    """Download the best available audio from a validated YouTube or Bilibili URL."""
    return _download_media(
        raw_url, work_dir, audio_only=True, proxy_port=proxy_port, proxy_url=proxy_url,
        ffmpeg_location=ffmpeg_location, cookiefile=cookiefile, check_cancel=check_cancel, progress=progress,
    )


def _find_downloaded_audio(candidate: Path, work_dir: Path) -> Path:
    def complete(path: Path) -> bool:
        return path.suffix not in _TEMP_SUFFIXES and path.is_file() and path.stat().st_size > 0

    if complete(candidate):
        return candidate
    for path in sorted(work_dir.glob("source.*")):
        if complete(path):
            return path
    raise AppError(502, "DOWNLOAD_FAILED", "yt-dlp did not produce a downloaded audio file.")


def _save_thumbnail(work_dir: Path, downloaded_path: Path, ffmpeg_exec: str) -> Path | None:
    cover = work_dir / "cover.jpg"
    temporary = work_dir / "cover.jpg.temp"
    for thumbnail in sorted(work_dir.glob("source.*")):
        if (
            thumbnail.suffix.lower() not in _THUMBNAIL_SUFFIXES
            or _TEMP_SUFFIXES.intersection(thumbnail.suffixes)
            or not thumbnail.is_file()
            or thumbnail.resolve() == downloaded_path.resolve()
        ):
            continue
        try:
            converted = False
            try:
                from PIL import Image, ImageOps

                with Image.open(thumbnail) as image:
                    ImageOps.exif_transpose(image).convert("RGB").save(temporary, format="JPEG", quality=95)
                converted = temporary.is_file() and temporary.stat().st_size > 0
            except Exception:
                converted = False
            if not converted:
                proc = subprocess.run(
                    [ffmpeg_exec, "-hide_banner", "-loglevel", "error", "-y", "-i", str(thumbnail), "-frames:v", "1", "-f", "mjpeg", str(temporary)],
                    capture_output=True,
                    timeout=15,
                )
                if proc.returncode != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
                    continue
            os.replace(temporary, cover)
        except Exception:
            # A missing codec or unreadable thumbnail must not discard a completed video.
            continue
        finally:
            temporary.unlink(missing_ok=True)
            if thumbnail.resolve() != cover.resolve():
                thumbnail.unlink(missing_ok=True)
        return cover
    return None


def _download_media(
    raw_url: str,
    work_dir: Path,
    *,
    audio_only: bool,
    proxy_port: Any,
    proxy_url: str,
    ffmpeg_location: str | None,
    cookiefile: str | None,
    check_cancel: Callable[[], None] | None,
    progress: Callable[[float | None, str], None] | None,
) -> tuple[Path, dict[str, Any]]:
    import yt_dlp
    from ..config import ffmpeg_binary

    target_url = video_url(raw_url)
    proxy = _resolve_proxy(proxy_port=proxy_port, proxy_url=proxy_url)
    media_type = "audio" if audio_only else "video"

    def _cancel_guard() -> None:
        if check_cancel is not None:
            check_cancel()

    _cancel_guard()
    target_url = _resolve_short_link(target_url, proxy)

    work_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_exec = ffmpeg_location or ffmpeg_binary()
    ffmpeg_dir = str(Path(ffmpeg_exec).parent) if Path(ffmpeg_exec).is_file() else (shutil.which(ffmpeg_exec) and str(Path(shutil.which(ffmpeg_exec) or "").parent))

    def _hook(status: dict[str, Any]) -> None:
        _cancel_guard()
        if progress is None:
            return
        total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
        downloaded = status.get("downloaded_bytes") or 0
        ratio = min(0.99, downloaded / total) if total > 0 else None
        state = status.get("status", "")
        if state == "downloading":
            pct = f" ({ratio * 100:.1f}%)" if ratio is not None else ""
            progress(ratio, f"Downloading source {media_type}{pct}")
        elif state == "finished":
            progress(0.99, f"Finalizing downloaded {media_type}")

    options: dict[str, Any] = {
        "outtmpl": str(work_dir / "source.%(ext)s"),
        "format": "bestaudio/best" if audio_only else "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "noplaylist": True,
        "retries": 0,
        "ignoreerrors": False,
        "quiet": True,
        "no_warnings": True,
        "proxy": proxy,
        "progress_hooks": [_hook],
        "match_filter": lambda info_dict: (
            "Live streams are not supported" if info_dict.get("is_live") else None
        ),
    }
    if not audio_only:
        options["merge_output_format"] = "mp4"
        options["writethumbnail"] = True
    if ffmpeg_dir:
        options["ffmpeg_location"] = ffmpeg_dir
    if cookiefile:
        cookie_path = Path(cookiefile).resolve()
        if cookie_path.is_file():
            options["cookiefile"] = str(cookie_path)
    js_runtimes = _resolve_js_runtimes()
    if js_runtimes:
        options["js_runtimes"] = js_runtimes
    has_cookiefile = bool(options.get("cookiefile"))

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(target_url, download=True)
            if not isinstance(info, dict):
                raise ApiError(502, "UNSUPPORTED_MEDIA", "Live streams or empty responses are not supported.", stage="download")
            candidate = Path(ydl.prepare_filename(info))
            if audio_only:
                downloaded_path = _find_downloaded_audio(candidate, work_dir)
            else:
                mp4_candidate = candidate.with_suffix(".mp4")
                downloaded_path = mp4_candidate if mp4_candidate.is_file() else candidate
                if not downloaded_path.is_file() or downloaded_path.stat().st_size == 0:
                    matches = sorted(
                        path for path in work_dir.glob("source.*")
                        if path.suffix.lower() not in _THUMBNAIL_SUFFIXES
                        and not _TEMP_SUFFIXES.intersection(path.suffixes)
                        and path.is_file() and path.stat().st_size > 0
                    )
                    if not matches:
                        raise AppError(502, "DOWNLOAD_FAILED", "yt-dlp did not produce a downloaded video file.")
                    downloaded_path = matches[0]
            meta = {
                "title": info.get("title") or downloaded_path.stem,
                "sourceUrl": target_url,
                "duration": info.get("duration"),
            }
            if not audio_only:
                cover = _save_thumbnail(work_dir, downloaded_path, ffmpeg_exec)
                if cover is not None:
                    meta["coverPath"] = str(cover)
            return downloaded_path, meta
    except BaseException as exc:
        # Never leave half-downloaded files when aborted or rejected cleanly.
        for item in list(work_dir.iterdir()):
            if item.is_file() and (item.name.startswith("source.") or item.name in {"cover.jpg", "cover.jpg.temp"}):
                item.unlink(missing_ok=True)
        if isinstance(exc, yt_dlp.utils.RejectedVideoReached):
            raise AppError(422, "UNSUPPORTED_MEDIA", str(exc) or "Live streams are not supported.") from exc
        if isinstance(exc, yt_dlp.utils.DownloadError):
            classified = _classify_download_error(exc, has_cookies=has_cookiefile)
            if classified is not None:
                raise classified from exc
        raise
