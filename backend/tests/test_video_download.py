from __future__ import annotations

from types import SimpleNamespace
from urllib.request import Request

import pytest
import yt_dlp

from backend.app.server import video_download
from backend.app.server.errors import AppError
from backend.app.server.video_download import SafeRedirectHandler, download_video, video_url
from backend.app.v1.errors import OperationCancelledError


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/a",
        "https://youtube.com.evil.com/watch?v=jNQXAC9IVRw",
        "https://b23.tv:8000/a",
        "https://www.youtube.com/playlist?list=x",
        "file:///etc/passwd",
    ],
)
def test_rejects_non_video_targets(url):
    with pytest.raises(AppError) as error:
        video_url(url)
    assert error.value.code == "INVALID_VIDEO_URL"


def test_short_link_redirect_is_checked_before_fetching():
    with pytest.raises(AppError) as error:
        SafeRedirectHandler().redirect_request(
            Request("https://b23.tv/abc"), None, 302, "Found", {}, "http://127.0.0.1/private"
        )
    assert error.value.code == "INVALID_VIDEO_URL"
    assert video_url("https://www.youtube.com/shorts/jNQXAC9IVRw") == "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    assert video_url("https://www.bilibili.com/video/BV1xx411c7mD/?p=2") == "https://www.bilibili.com/video/BV1xx411c7mD/?p=2"


@pytest.mark.parametrize("port", [-1, 65536, 1.5, True, "7897"])
def test_invalid_proxy_port_fails_before_network_access(tmp_path, monkeypatch, port):
    monkeypatch.setattr(yt_dlp, "YoutubeDL", lambda *_: pytest.fail("Invalid port reached the downloader"))
    with pytest.raises(AppError) as error:
        download_video("https://youtu.be/jNQXAC9IVRw", tmp_path, proxy_port=port)
    assert error.value.code == "INVALID_CONFIG"


@pytest.mark.parametrize("port", [None, "", 0, 1, 7897, 65535])
@pytest.mark.parametrize("short_link", [False, True])
def test_proxy_reaches_downloader_and_short_link_resolver(tmp_path, monkeypatch, port, short_link):
    expected = f"http://127.0.0.1:{port}" if port else ""
    url = "https://b23.tv/abc" if short_link else "https://youtu.be/jNQXAC9IVRw"
    work = tmp_path / "download"
    received = {}

    class Response:
        url = "https://www.bilibili.com/video/BV1xx411c7mD/"

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

    def opener(*handlers):
        received["redirectProxy"] = handlers[0].proxies
        assert isinstance(handlers[1], SafeRedirectHandler)
        return SimpleNamespace(open=lambda *_args, **_kwargs: Response())

    monkeypatch.setattr(video_download, "build_opener", opener)

    class Downloader:
        def __init__(self, options):
            self.options = received["options"] = options

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def extract_info(self, url, download):
            received["url"] = url
            assert download is True
            work.mkdir(parents=True, exist_ok=True)
            (work / "source.mp4").write_bytes(b"video")
            return {"title": "Proxy contract video", "duration": 19}

        def prepare_filename(self, _):
            return str(work / "source.mp4")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)
    path, meta = download_video(url, work, proxy_port=port)
    assert path == work / "source.mp4"
    assert received["options"]["proxy"] == expected
    assert received["options"]["retries"] == 0
    assert received["options"]["ignoreerrors"] is False
    assert meta["sourceUrl"] == received["url"]
    if short_link:
        assert received["redirectProxy"] == ({"http": expected, "https": expected} if expected else {})
        assert received["url"] == Response.url
    else:
        assert received["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw"


@pytest.mark.parametrize("mode", ["network", "live", "cancel"])
def test_download_failure_never_leaves_partial_file(tmp_path, monkeypatch, mode):
    original = RuntimeError("download network failure")

    class Downloader:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def extract_info(self, *_args, **_kwargs):
            (tmp_path / "source.mp4").write_bytes(b"partial")
            if mode == "network":
                raise original
            if mode == "live":
                raise yt_dlp.utils.RejectedVideoReached("live")
            pytest.fail("Rejected download continued")

    def cancelled():
        raise OperationCancelledError("CANCELLED", "cancelled")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)
    with pytest.raises((RuntimeError, AppError, OperationCancelledError)) as error:
        download_video(
            "https://youtu.be/jNQXAC9IVRw",
            tmp_path,
            check_cancel=cancelled if mode == "cancel" else None,
        )
    if mode == "network":
        assert error.value is original
    elif mode == "live":
        assert error.value.code == "UNSUPPORTED_MEDIA"
    else:
        assert error.value.code == "CANCELLED"
    assert not list(tmp_path.iterdir())


def test_download_options_populate_js_runtimes_and_cookiefile(tmp_path, monkeypatch):
    from pathlib import Path

    captured: list[dict] = []
    fake_node = tmp_path / "node-bin"
    fake_node.write_bytes(b"#!/bin/sh\n")
    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")

    def make_downloader(work_dir: Path):
        class Downloader:
            def __init__(self, options):
                captured.append(dict(options))

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def extract_info(self, *_args, **_kwargs):
                (work_dir / "source.mp4").write_bytes(b"video")
                return {"title": "Sample", "duration": 10}

            def prepare_filename(self, _info):
                return str(work_dir / "source.mp4")

        return Downloader

    run1 = tmp_path / "run1"
    run1.mkdir()
    monkeypatch.setenv("YOUDUB_NODE_PATH", str(fake_node))
    monkeypatch.setattr(yt_dlp, "YoutubeDL", make_downloader(run1))
    download_video("https://youtu.be/jNQXAC9IVRw", run1, cookiefile=str(cookie_file))
    assert captured[-1]["js_runtimes"]["node"]["path"] == str(fake_node.resolve())
    assert captured[-1]["cookiefile"] == str(cookie_file.resolve())

    run2 = tmp_path / "run2"
    run2.mkdir()
    monkeypatch.delenv("YOUDUB_NODE_PATH", raising=False)
    monkeypatch.setattr(
        video_download.shutil,
        "which",
        lambda binary: str(fake_node) if binary == "node" else None,
    )
    monkeypatch.setattr(yt_dlp, "YoutubeDL", make_downloader(run2))
    download_video("https://youtu.be/jNQXAC9IVRw", run2, cookiefile=str(tmp_path / "missing.txt"))
    assert captured[-1]["js_runtimes"]["node"]["path"] == str(fake_node.resolve())
    assert "cookiefile" not in captured[-1]


@pytest.mark.parametrize(
    ("raw_error", "with_cookies", "expected_code"),
    [
        (
            "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
            False,
            "YOUTUBE_COOKIES_REQUIRED",
        ),
        (
            "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies for authentication.",
            True,
            "YOUTUBE_COOKIES_EXPIRED",
        ),
        (
            "ERROR: [youtube] abc: The provided YouTube account cookies are no longer valid.",
            False,
            "YOUTUBE_COOKIES_EXPIRED",
        ),
        (
            "ERROR: [youtube] jNQXAC9IVRw: No video formats found!",
            False,
            "DOWNLOAD_NO_FORMATS",
        ),
        (
            "ERROR: [youtube] aaaaaaaaaaa: Video unavailable",
            False,
            "VIDEO_UNAVAILABLE",
        ),
        (
            "ERROR: [youtube] aaaaaaaaaaa: This video is unavailable",
            False,
            "VIDEO_UNAVAILABLE",
        ),
        (
            "ERROR: [youtube] aaaaaaaaaaa: The uploader has not made this video available in your country",
            False,
            "VIDEO_UNAVAILABLE",
        ),
        (
            "ERROR: [youtube] aaaaaaaaaaa: Unable to download webpage: timed out",
            False,
            "DOWNLOAD_NETWORK_ERROR",
        ),
    ],
)
def test_download_classifies_yt_dlp_errors_and_preserves_raw_message(
    tmp_path, monkeypatch, raw_error, with_cookies, expected_code
):
    cookie_path = None
    if with_cookies:
        cookie_path = tmp_path / "cookies.txt"
        cookie_path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")

    class FailingDownloader:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def extract_info(self, *_args, **_kwargs):
            raise yt_dlp.utils.DownloadError(raw_error)

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FailingDownloader)
    with pytest.raises(AppError) as exc_info:
        download_video(
            "https://youtu.be/jNQXAC9IVRw",
            tmp_path,
            cookiefile=str(cookie_path) if cookie_path else None,
        )
    assert exc_info.value.code == expected_code
    assert raw_error in exc_info.value.message
