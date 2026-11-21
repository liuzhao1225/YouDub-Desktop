"""Tests for ResourceManager: disk detection, mirror fallback, SHA256 check, yt-dlp update."""

from __future__ import annotations

import hashlib
import subprocess
from types import SimpleNamespace

import httpx
import pytest

from backend.app.server.events import EventHub
from backend.app.server.resources import ResourceManager
from backend.app.server.settings import SettingsStore


def test_setup_is_lightweight_once_data_dir_configured(tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    events = EventHub()
    rm = ResourceManager(settings, events)

    initial = rm.setup_state()
    assert initial["phase"] == "installation"
    assert initial["installation"]["required"] is True

    configured = rm.handle_setup_post({"action": "configure", "path": str(tmp_path / "data")})
    assert configured["phase"] == "ready"
    assert (tmp_path / "data" / "models").is_dir()


def test_detects_existing_models_including_large_v3_turbo_default(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    data_dir = settings.configure_data_dir(str(tmp_path / "data"))
    monkeypatch.delenv("YOUDUB_WHISPER_MODELS_DIR", raising=False)
    monkeypatch.delenv("YOUDUB_DEMUCS_MODELS_DIR", raising=False)

    whisper_dir = data_dir / "models" / "whisper"
    whisper_dir.mkdir(parents=True, exist_ok=True)
    (whisper_dir / "large-v3-turbo.pt").write_bytes(b"turbo-weights")
    (whisper_dir / "small.pt").write_bytes(b"small-weights")

    demucs_dir = data_dir / "models" / "demucs"
    demucs_dir.mkdir(parents=True, exist_ok=True)
    (demucs_dir / "955717e8-8726e21a.th").write_bytes(b"demucs-weights")

    rm = ResourceManager(settings, EventHub())
    inv = rm.inventory()
    whisper_entry = next(m for m in inv["models"] if m["id"] == "whisper")
    assert whisper_entry["variant"] == "large-v3-turbo"
    assert whisper_entry["status"] == "ready"
    demucs_entry = next(m for m in inv["models"] if m["id"] == "demucs")
    assert demucs_entry["status"] == "ready"
    assert rm.installed_whisper_variants() == ["large-v3-turbo", "small"]


@pytest.mark.anyio
async def test_download_falls_back_to_mirror_and_verifies_sha256(monkeypatch, tmp_path):
    payload = b"verified-model-bytes-12345"
    sha = hashlib.sha256(payload).hexdigest()
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        if "primary" in str(request.url):
            return httpx.Response(503, text="primary down")
        return httpx.Response(200, content=payload, headers={"content-length": str(len(payload))})

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    data_dir = settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub(), transport=httpx.MockTransport(handler))
    monkeypatch.setattr(rm, "_models_manifest", [
        {
            "id": "demucs",
            "name": "Demucs",
            "variant": "htdemucs",
            "purpose": "人声分离",
            "directory": "demucs",
            "files": [
                {
                    "path": "test.th",
                    "size": len(payload),
                    "sha256": sha,
                    "url": "https://primary.example/test.th",
                    "mirrors": ["https://mirror.example/test.th"],
                }
            ],
        }
    ])

    await rm._download_model("demucs")
    assert len(seen_urls) == 2
    assert (data_dir / "models" / "demucs" / "test.th").read_bytes() == payload
    assert rm.is_model_ready("demucs")


def test_update_yt_dlp_runs_uv_upgrade(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())
    seen_cmds: list[list[str]] = []

    monkeypatch.setattr(rm, "find_uv", lambda: "/usr/local/bin/uv")
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    monkeypatch.setattr("backend.app.server.resources.subprocess.run", lambda cmd, **_kw: (seen_cmds.append(cmd) or SimpleNamespace(returncode=0, stdout="", stderr="")))

    versions = iter(["2026.10.26", "2026.11.20", "2026.11.20"])
    monkeypatch.setattr(rm, "_probe_python_env", lambda _py: {"yt-dlp": next(versions)})

    upgraded = rm.update_yt_dlp()
    assert upgraded == {"ok": True, "version": "2026.11.20", "previousVersion": "2026.10.26", "updated": True}
    assert seen_cmds == [["/usr/local/bin/uv", "pip", "install", "--python", "/venv/bin/python", "--upgrade", "yt-dlp"]]
    assert rm.yt_dlp_info()["updateAvailable"] is False

    unchanged = rm.update_yt_dlp()
    assert unchanged == {"ok": True, "version": "2026.11.20", "previousVersion": "2026.11.20", "updated": False}


@pytest.mark.anyio
async def test_check_yt_dlp_update_detects_newer_version_with_mirror_fallback_and_cache(monkeypatch, tmp_path):
    seen_urls: list[str] = []
    fail_all = False

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        if fail_all:
            raise httpx.ConnectError("offline")
        if "pypi.org" in str(request.url):
            return httpx.Response(503, text="pypi busy")
        return httpx.Response(200, json={"info": {"version": "2026.12.01"}})

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub(), transport=httpx.MockTransport(handler))
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    monkeypatch.setattr(rm, "_probe_python_env", lambda _py: {"yt-dlp": "2026.10.26"})

    info = await rm.check_yt_dlp_update()
    assert info == {
        "version": "2026.10.26",
        "installed": True,
        "latestVersion": "2026.12.01",
        "updateAvailable": True,
        "checked": True,
    }
    assert len(seen_urls) == 2

    # Subsequent call hits 6-hour TTL cache without hitting network
    cached = await rm.check_yt_dlp_update()
    assert cached["updateAvailable"] is True
    assert len(seen_urls) == 2

    # Forced offline check degrades cleanly without raising
    fail_all = True
    offline_info = await rm.check_yt_dlp_update(force=True)
    assert offline_info["installed"] is True
    assert offline_info["version"] == "2026.10.26"


def test_delete_model_variant_removes_only_targeted_weights_and_updates_disk_bytes(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    data_dir = settings.configure_data_dir(str(tmp_path / "data"))
    monkeypatch.delenv("YOUDUB_WHISPER_MODELS_DIR", raising=False)

    whisper_dir = data_dir / "models" / "whisper"
    whisper_dir.mkdir(parents=True, exist_ok=True)
    turbo = whisper_dir / "large-v3-turbo.pt"
    small = whisper_dir / "small.pt"
    turbo.write_bytes(b"a" * 12)
    small.write_bytes(b"b" * 20)

    rm = ResourceManager(settings, EventHub())
    inv = rm.inventory()
    assert inv["storage"]["diskBytes"] == 32
    assert rm.installed_whisper_variants() == ["large-v3-turbo", "small"]

    updated = rm.perform_action("delete", "whisper:small")
    assert not small.exists()
    assert turbo.exists()
    assert updated["storage"]["diskBytes"] == 12
    assert rm.installed_whisper_variants() == ["large-v3-turbo"]
    small_variant = next(v for v in updated["whisperVariants"] if v["id"] == "small")
    assert small_variant["status"] == "pending"
    assert small_variant["installed"] is False


@pytest.mark.anyio
async def test_resume_while_preparation_active_queues_follow_up_download(monkeypatch, tmp_path):
    import asyncio

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())

    monkeypatch.setattr(rm, "resolve_ffmpeg", lambda: ("/usr/bin/ffmpeg", "/usr/bin/ffprobe"))
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    downloaded: list[str] = []
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_download(download_id: str) -> None:
        downloaded.append(download_id)
        if download_id == "voxcpm":
            first_started.set()
            await release_first.wait()

    monkeypatch.setattr(rm, "_download_model", fake_download)
    rm.start_prepare(resource_ids=["voxcpm"])
    await first_started.wait()

    # Queueing resume for another model while _prep_task is still active must not be dropped
    rm.perform_action("resume", "demucs")
    release_first.set()
    assert rm._prep_task is not None
    await rm._prep_task
    assert downloaded == ["voxcpm", "demucs"]
