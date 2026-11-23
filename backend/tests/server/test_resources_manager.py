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


def test_probe_python_env_probes_symlinked_venv_via_subprocess(monkeypatch, tmp_path):
    import json
    import sys
    from backend.app.server.resources import _is_same_python_env

    venv_bin = tmp_path / "venv" / ("Scripts" if sys.platform == "win32" else "bin")
    venv_bin.mkdir(parents=True)
    venv_py = venv_bin / ("python.exe" if sys.platform == "win32" else "python")
    try:
        venv_py.symlink_to(sys.executable)
    except OSError:
        pytest.skip("Symlinks are not permitted on this platform")

    assert _is_same_python_env(sys.executable) is True
    assert _is_same_python_env(str(venv_py)) is False

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())

    seen_cmds: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        seen_cmds.append(cmd)
        return SimpleNamespace(returncode=0, stdout=json.dumps({"soundfile": "0.14.0", "numpy": "2.5.5"}), stderr="")

    monkeypatch.setattr("backend.app.server.resources.subprocess.run", fake_run)
    probed = rm._probe_python_env(str(venv_py))
    assert seen_cmds and seen_cmds[0][0] == str(venv_py)
    assert probed["soundfile"] == "0.14.0"
    assert probed["numpy"] == "2.5.5"


def test_managed_venv_python_rejects_unrunnable_binary(tmp_path):
    import sys

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    data_dir = settings.configure_data_dir(str(tmp_path / "data"))
    venv_py = data_dir / "runtime" / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    venv_py.parent.mkdir(parents=True, exist_ok=True)
    venv_py.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    if sys.platform != "win32":
        venv_py.chmod(0o755)

    rm = ResourceManager(settings, EventHub())
    assert rm.managed_venv_python() is None


@pytest.mark.anyio
async def test_prepare_environment_fails_when_packages_still_missing_after_install(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())

    monkeypatch.setattr(rm, "resolve_ffmpeg", lambda: ("/usr/bin/ffmpeg", "/usr/bin/ffprobe"))
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    monkeypatch.setattr(rm, "_probe_python_env", lambda _py: {"soundfile": None, "numpy": None})

    async def noop_install(_py, _groups, _state=None):
        return None

    monkeypatch.setattr(rm, "_install_python_dependencies", noop_install)

    await rm._run_preparation(["dependencies"])
    assert rm._state.status == "failed"
    deps_step = rm._state.environment["dependencies"]
    assert deps_step.status == "failed"
    assert "soundfile" in (deps_step.error or "")
    assert "numpy" in (deps_step.error or "")


def test_accelerator_status_and_runtime_api_use_compute_venv_devices(monkeypatch, tmp_path):
    import json
    from fastapi.testclient import TestClient
    from backend.app.server.api import create_app

    app = create_app(config_dir=tmp_path / "cfg")
    client = TestClient(app)
    with client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")})
        rm = app.state.resources
        monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
        monkeypatch.setattr("backend.app.server.resources._is_same_python_env", lambda _py: False)

        has_torch = False

        def fake_probe(_py):
            return {
                "soundfile": "0.14.0",
                "numpy": "2.5.5",
                "torch": "2.8.0" if has_torch else None,
                "torchaudio": "2.8.0" if has_torch else None,
            }

        monkeypatch.setattr(rm, "_probe_python_env", fake_probe)

        # Before torch is installed: acceleration is pending with plan detail
        inv_before = rm.inventory()
        accel_before = next(s for s in inv_before["environment"] if s["id"] == "acceleration")
        assert accel_before["status"] == "pending"

        # After torch is installed in compute venv: subprocess probe reports Apple MPS
        has_torch = True
        rm.invalidate_probe_cache()
        monkeypatch.setattr(rm, "resolve_ffmpeg", lambda: ("/usr/bin/ffmpeg", "/usr/bin/ffprobe"))
        seen_py: list[str] = []

        def fake_subproc(cmd, **_kwargs):
            seen_py.append(cmd[0])
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    [
                        {"id": "mps", "name": "Apple MPS", "backend": "mps", "available": True, "unavailable_reason": None},
                        {"id": "cpu", "name": "CPU", "backend": "cpu", "available": True, "unavailable_reason": None},
                    ]
                ),
                stderr="",
            )

        monkeypatch.setattr("backend.app.server.resources.subprocess.run", fake_subproc)
        inv_after = rm.inventory()
        accel_after = next(s for s in inv_after["environment"] if s["id"] == "acceleration")
        assert accel_after["status"] == "ready"
        assert accel_after["detail"] == "Backend: mps"
        assert seen_py == ["/venv/bin/python"]

        runtime = client.get("/api/runtime").json()
        assert runtime["devices"][0]["id"] == "mps"
        node_types = client.get("/api/node-types").json()["items"]
        synth = next(n for n in node_types if n["type"] == "youdub.synthesize")
        assert "mps" in synth["provider"]["models"][0]["devices"]


@pytest.mark.anyio
async def test_install_python_dependencies_prefers_china_mirrors_pins_torch_and_streams_logs(monkeypatch, tmp_path):
    from backend.app.server.resources import DownloadProgressState

    probed_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        probed_urls.append(str(request.url))
        # Fail Aliyun PyPI probe to verify fallback to Tsinghua
        if "mirrors.aliyun.com/pypi" in str(request.url):
            return httpx.Response(503, text="busy")
        return httpx.Response(200, text="ok")

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    data_dir = settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub(), transport=httpx.MockTransport(handler))
    monkeypatch.setattr(rm, "find_uv", lambda: "/usr/local/bin/uv")
    monkeypatch.setattr(rm, "_probe_python_env", lambda _py: {})
    monkeypatch.setattr(
        "backend.app.server.resources.hardware",
        lambda: {
            "system": "Windows",
            "arch": "amd64",
            "gpus": [{"vendor": "nvidia", "name": "RTX 4090", "driver": "550.0", "capability": "8.9"}],
        },
    )

    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9999")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9999")

    class FakeStdout:
        def __init__(self, lines: list[bytes]) -> None:
            self._lines = list(lines)

        async def readline(self) -> bytes:
            return self._lines.pop(0) if self._lines else b""

    seen_cmds: list[list[str]] = []
    seen_envs: list[dict[str, str]] = []

    async def fake_exec(*cmd, **kwargs):
        seen_cmds.append(list(cmd))
        seen_envs.append(dict(kwargs["env"]))
        return SimpleNamespace(
            stdout=FakeStdout([b"Resolved 2 packages in 10ms\n", b"Downloading torch (10.0 MiB)\n", b"Installed 2 packages\n"]),
            wait=lambda: __import__("asyncio").sleep(0, result=0),
        )

    monkeypatch.setattr("backend.app.server.resources.asyncio.create_subprocess_exec", fake_exec)

    state = DownloadProgressState(status="running", phase="installing")
    await rm._install_python_dependencies("/venv/bin/python", ["voxcpm"], state)

    # Probe order for zh + direct: Aliyun first, then Tsinghua, then PyPI
    pypi_probes = [u for u in probed_urls if "/packaging/" in u]
    assert "mirrors.aliyun.com/pypi" in pypi_probes[0]
    assert "pypi.tuna.tsinghua.edu.cn" in pypi_probes[1]
    assert "pypi.org" in pypi_probes[2]
    # Because Aliyun failed probe, Tsinghua index + Aliyun pytorch-wheels are selected
    assert len(seen_cmds) == 2
    assert "--index-url" in seen_cmds[0] and "https://pypi.tuna.tsinghua.edu.cn/simple/" in seen_cmds[0]
    assert "--find-links" in seen_cmds[0] and "https://mirrors.aliyun.com/pytorch-wheels/cu126/" in seen_cmds[0]
    assert "torch==2.8.0+cu126" in seen_cmds[0]

    # Constraints file generated & passed to requirement install
    constraints_file = data_dir / "runtime" / "torch-constraints.txt"
    assert constraints_file.is_file()
    assert "torchcodec==0.7.0" in constraints_file.read_text(encoding="utf-8")
    assert "-c" in seen_cmds[1] and str(constraints_file) in seen_cmds[1]

    # Stale env proxies stripped when settings.proxy_url is empty; uv config isolated
    assert "HTTP_PROXY" not in seen_envs[0]
    assert "http_proxy" not in seen_envs[0]
    assert seen_envs[0]["UV_NO_CONFIG"] == "1"
    assert seen_envs[0]["UV_HTTP_TIMEOUT"] == "20"

    # Streamed logs and source recorded on state
    assert state.source == "pypi.tuna.tsinghua.edu.cn"
    assert "Downloading torch (10.0 MiB)" in state.log
    assert state.activity == "Installed 2 packages"


@pytest.mark.anyio
async def test_download_prefers_china_mirrors_for_zh_direct_and_remembers_failed_hosts(tmp_path):
    from backend.app.server.resources import DownloadProgressState

    payload = b"china-mirror-first"
    sha = hashlib.sha256(payload).hexdigest()
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        if "huggingface.co" in url:
            return httpx.Response(503, text="blocked")
        return httpx.Response(200, content=payload, headers={"content-length": str(len(payload))})

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub(), transport=httpx.MockTransport(handler))

    # 1. zh + no proxy tries modelscope.cn directly first (0 foreign hits)
    asset = {
        "path": "a.bin",
        "sha256": sha,
        "url": "https://huggingface.co/org/model/resolve/main/a.bin",
        "mirrors": ["https://modelscope.cn/api/v1/models/org/model/repo?FilePath=a.bin"],
    }
    await rm._download_asset_with_mirrors(asset, tmp_path / "a.bin", DownloadProgressState())
    assert seen_urls == ["https://modelscope.cn/api/v1/models/org/model/repo?FilePath=a.bin"]

    # 2. en tries huggingface.co first; after failure, huggingface.co is deprioritized on next file
    seen_urls.clear()
    settings.update_general(ui_language="en")
    await rm._download_asset_with_mirrors(asset, tmp_path / "b.bin", DownloadProgressState())
    assert seen_urls == [
        "https://huggingface.co/org/model/resolve/main/a.bin",
        "https://modelscope.cn/api/v1/models/org/model/repo?FilePath=a.bin",
    ]
    seen_urls.clear()
    await rm._download_asset_with_mirrors(asset, tmp_path / "c.bin", DownloadProgressState())
    assert seen_urls == ["https://modelscope.cn/api/v1/models/org/model/repo?FilePath=a.bin"]


@pytest.mark.anyio
async def test_install_ffmpeg_win32_falls_back_to_mirror_archive(monkeypatch, tmp_path):
    import io
    import tarfile
    from backend.app.server.resources import DownloadProgressState

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz") as tf:
        for name in ("ffmpeg-7.1.5-win32-x64-gpl-shared/bin/ffmpeg.exe", "ffmpeg-7.1.5-win32-x64-gpl-shared/bin/ffprobe.exe"):
            info = tarfile.TarInfo(name=name)
            data = b"exe-stub"
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    archive_bytes = buf.getvalue()
    archive_sha = hashlib.sha256(archive_bytes).hexdigest()

    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        if "github.com" in url:
            return httpx.Response(503, text="github unreachable")
        return httpx.Response(200, content=archive_bytes, headers={"content-length": str(len(archive_bytes))})

    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    settings.update_general(ui_language="en")
    rm = ResourceManager(settings, EventHub(), transport=httpx.MockTransport(handler))
    monkeypatch.setattr("backend.app.server.resources._platform_key", lambda: "win32-x64")
    monkeypatch.setattr(
        rm,
        "_runtime_manifest",
        {
            "ffmpeg": {
                "win32-x64": [
                    {
                        "path": "ffmpeg.zip",
                        "sha256": "deadbeef",
                        "url": "https://github.com/example/ffmpeg.zip",
                    },
                    {
                        "path": "ffmpeg.tar.xz",
                        "sha256": archive_sha,
                        "url": "https://registry.npmmirror.com/-/binary/ffmpeg-builds/ffmpeg.tar.xz",
                    },
                ]
            }
        },
    )

    ff_dir = tmp_path / "ffmpeg"
    await rm._install_ffmpeg(ff_dir, DownloadProgressState())
    assert seen_urls == [
        "https://github.com/example/ffmpeg.zip",
        "https://registry.npmmirror.com/-/binary/ffmpeg-builds/ffmpeg.tar.xz",
    ]
    assert any(ff_dir.rglob("ffmpeg.exe"))
    assert any(ff_dir.rglob("ffprobe.exe"))


@pytest.mark.anyio
async def test_yt_dlp_install_targets_download_group_and_exposes_live_status(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())

    monkeypatch.setattr(rm, "resolve_ffmpeg", lambda: ("/usr/bin/ffmpeg", "/usr/bin/ffprobe"))
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    monkeypatch.setattr(rm, "_probe_python_env", lambda _py: {})

    seen_groups: list[list[str]] = []

    async def failing_install(_py, groups, state=None):
        seen_groups.append(groups)
        if state is not None:
            state.source = "mirrors.aliyun.com"
            state.activity = "Downloading yt-dlp"
        dl_entry_during = next(e for e in rm.inventory()["entries"] if e["id"] == "youdub.download")
        assert dl_entry_during["status"] == "preparing"
        assert dl_entry_during["source"] == "mirrors.aliyun.com"
        raise RuntimeError("pypi unreachable")

    monkeypatch.setattr(rm, "_install_python_dependencies", failing_install)
    await rm._run_preparation(["youdub.download"])
    assert seen_groups == [["media", "download"]]
    assert rm._state.status == "failed"
    dl_entry_failed = next(e for e in rm.inventory()["entries"] if e["id"] == "youdub.download")
    assert dl_entry_failed["status"] == "failed"
    assert dl_entry_failed["actions"] == ["retry"]
    assert "pypi unreachable" in (dl_entry_failed["error"] or "")


def test_models_manifest_has_modelscope_mirrors_and_no_broken_hf_mirror():
    from backend.app.server.resources import _load_models_manifest

    manifest = _load_models_manifest()
    for spec in manifest:
        file_lists = list((spec.get("variants") or {}).values()) + ([spec["files"]] if spec.get("files") else [])
        for files in file_lists:
            for item in files:
                mirrors = item.get("mirrors") or []
                assert any("modelscope.cn" in m for m in mirrors), f"Missing modelscope.cn mirror on {spec['id']}/{item['path']}"
                assert all("hf-mirror.com" not in m for m in mirrors), f"Unexpected hf-mirror.com on {spec['id']}/{item['path']}"
    whisper = next(m for m in manifest if m["id"] == "whisper")
    assert whisper["variants"]["large-v3-turbo"][0]["size"] == 1617941637
    assert whisper["files"][0]["size"] == 1617941637


@pytest.mark.anyio
async def test_mismatched_cpu_torch_on_cuda_host_is_flagged_and_repaired(monkeypatch, tmp_path):
    settings = SettingsStore(config_dir=tmp_path / "cfg")
    settings.configure_data_dir(str(tmp_path / "data"))
    rm = ResourceManager(settings, EventHub())

    monkeypatch.setattr(rm, "resolve_ffmpeg", lambda: ("/usr/bin/ffmpeg", "/usr/bin/ffprobe"))
    monkeypatch.setattr(rm, "compute_python", lambda: "/venv/bin/python")
    monkeypatch.setattr(rm, "find_uv", lambda: "/usr/local/bin/uv")
    monkeypatch.setattr(
        "backend.app.server.resources.hardware",
        lambda: {
            "system": "Windows",
            "arch": "amd64",
            "gpus": [{"vendor": "nvidia", "name": "NVIDIA GeForce RTX 3060", "driver": "560.94", "capability": "8.6"}],
        },
    )

    state = {
        "torch": "2.15.0",
        "torchaudio": "2.11.1",
        "torchcodec": "0.17.0",
        "backend": "cpu",
    }

    def fake_probe(_py):
        return {
            "soundfile": "0.14.0",
            "numpy": "2.2.0",
            "voxcpm": "2.0.3",
            "transformers": "5.17.0",
            "librosa": "0.11.0",
            "einops": "0.8.1",
            "huggingface-hub": "0.34.0",
            "safetensors": "0.5.3",
            "tqdm": "4.67.1",
            "torch": state["torch"],
            "torchaudio": state["torchaudio"],
            "torchcodec": state["torchcodec"],
        }

    def fake_devices():
        if state["backend"] == "cuda":
            return [
                {"id": "cuda:0", "name": "NVIDIA GeForce RTX 3060", "backend": "cuda", "available": True, "unavailable_reason": None},
                {"id": "cpu", "name": "CPU", "backend": "cpu", "available": True, "unavailable_reason": None},
            ]
        return [{"id": "cpu", "name": "CPU", "backend": "cpu", "available": True, "unavailable_reason": None}]

    monkeypatch.setattr(rm, "_probe_python_env", fake_probe)
    monkeypatch.setattr(rm, "detect_compute_devices", fake_devices)

    # Mismatched v0.1.2 PyPI CPU Torch on RTX 3060 must be surfaced as pending / needing repair
    inv_before = rm.inventory()
    accel_before = next(e for e in inv_before["environment"] if e["id"] == "acceleration")
    assert accel_before["status"] == "pending"
    assert "2.15.0" in (accel_before["detail"] or "")
    assert "CU126" in (accel_before["detail"] or "")
    assert "torch" in rm._missing_groups_for_provider("voxcpm")

    # Running preparation for "acceleration" repairs torch, torchaudio, and torchcodec
    async def fake_probe_http(_url):
        return True

    seen_cmds: list[list[str]] = []

    class FakeStdout:
        async def readline(self) -> bytes:
            return b""

    async def fake_exec(*cmd, **_kwargs):
        seen_cmds.append(list(cmd))
        state.update(torch="2.8.0+cu126", torchaudio="2.8.0+cu126", torchcodec="0.7.0", backend="cuda")
        return SimpleNamespace(stdout=FakeStdout(), wait=lambda: __import__("asyncio").sleep(0, result=0))

    monkeypatch.setattr(rm, "_probe_http_source", fake_probe_http)
    monkeypatch.setattr("backend.app.server.resources.asyncio.create_subprocess_exec", fake_exec)

    await rm._run_preparation(["acceleration"])
    assert rm._state.status == "ready"
    assert len(seen_cmds) == 1
    assert "torch==2.8.0+cu126" in seen_cmds[0]
    assert "torchaudio==2.8.0+cu126" in seen_cmds[0]
    assert "torchcodec==0.7.0" in seen_cmds[0]

    inv_after = rm.inventory()
    accel_after = next(e for e in inv_after["environment"] if e["id"] == "acceleration")
    assert accel_after["status"] == "ready"
    assert accel_after["detail"] == "Backend: cuda"
    assert rm._missing_groups_for_provider("voxcpm") == []
