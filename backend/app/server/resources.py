"""Unified runtime environment, model weight detection, streaming download, and yt-dlp updates."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from ..accelerators import accelerator_status, hardware, installation_plan
from ..config import ffmpeg_binary, ffprobe_binary
from .errors import AppError
from .events import EventHub
from .settings import LLMProviderConfig, SettingsStore, default_data_dir

MANIFESTS_DIR = Path(__file__).resolve().parents[1] / "manifests"
REQUIREMENTS_DIR = Path(__file__).resolve().parents[2] / "requirements"
REPO_ROOT = Path(__file__).resolve().parents[3]
APP_VERSION = "0.1.2"
_YTDLP_CHECK_TTL_SECONDS = 6 * 3600


def _version_tuple(version: str | None) -> tuple[int, ...]:
    if not version:
        return ()
    parts: list[int] = []
    for token in version.strip().split("."):
        match = re.match(r"^\d+", token)
        if not match:
            break
        parts.append(int(match.group(0)))
    return tuple(parts)


def _is_newer_version(latest: str | None, current: str | None) -> bool:
    if not latest or not current:
        return False
    latest_parts = _version_tuple(latest)
    current_parts = _version_tuple(current)
    if not latest_parts or not current_parts:
        return latest.strip() != current.strip()
    return latest_parts > current_parts


def _load_models_manifest() -> list[dict[str, Any]]:
    return json.loads((MANIFESTS_DIR / "setup-models.json").read_text(encoding="utf-8"))


def _load_runtime_manifest() -> dict[str, Any]:
    return json.loads((MANIFESTS_DIR / "setup-runtime.json").read_text(encoding="utf-8"))


def _load_requirements_manifest() -> dict[str, Any]:
    return json.loads((REQUIREMENTS_DIR / "resources.json").read_text(encoding="utf-8"))


def _platform_key() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    plat = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}.get(platform.system(), sys.platform)
    return f"{plat}-{arch}"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class DownloadProgressState:
    status: str = "pending"  # pending | downloading | paused | ready | failed
    received: int = 0
    total: int = 0
    speed: float = 0.0
    source: str | None = None
    error: str | None = None
    detail: str | None = None
    phase: str | None = None  # downloading | installing | verifying
    pause_requested: bool = False
    started_at: int | None = None
    updated_at: int | None = None


@dataclass
class PreparationState:
    status: str = "missing"  # missing | preparing | ready | failed
    error: str | None = None
    environment: dict[str, DownloadProgressState] = field(default_factory=dict)
    models: dict[str, DownloadProgressState] = field(default_factory=dict)


class ResourceManager:
    """Single source of truth for runtime dependencies, ffmpeg, yt-dlp, and ML models."""

    def __init__(
        self,
        settings: SettingsStore,
        events: EventHub,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.events = events
        self._transport = transport
        self._models_manifest = _load_models_manifest()
        self._runtime_manifest = _load_runtime_manifest()
        self._req_manifest = _load_requirements_manifest()
        self._state = PreparationState()
        self._prep_task: asyncio.Task[None] | None = None
        self._pending_targets: list[str] = []
        self._ffmpeg_cache: tuple[str, tuple[str | None, str | None]] | None = None
        self._pkg_cache: tuple[str, dict[str, str | None]] | None = None
        self._yt_dlp_version_cache: tuple[str, str | None] | None = None
        self._yt_dlp_latest_cache: tuple[float, str | None] | None = None
        self._last_emit = 0.0

    def _emit_updated(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_emit) < 0.25:
            return
        self._last_emit = now
        self.events.publish("resources.updated", {"status": self._state.status})

    def _data_root(self) -> Path | None:
        return self.settings.data_path()

    def is_preparing(self) -> bool:
        prep_active = self._prep_task is not None and not self._prep_task.done()
        return prep_active or self._state.status == "preparing"

    # ------------------------------------------------------------------
    # Binary & venv resolution
    # ------------------------------------------------------------------

    def find_uv(self) -> str | None:
        for candidate in (
            os.getenv("YOUDUB_UV_BIN", "").strip(),
            shutil.which("uv") or "",
        ):
            if candidate and Path(candidate).is_file():
                return candidate
        data = self._data_root()
        if data:
            uv_dir = data / "runtime" / "uv"
            exe = "uv.exe" if sys.platform == "win32" else "uv"
            for match in uv_dir.rglob(exe):
                if match.is_file():
                    return str(match)
        return None

    def managed_venv_python(self) -> Path | None:
        data = self._data_root()
        if not data:
            return None
        venv = data / "runtime" / "venv"
        py = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        return py if py.is_file() else None

    def compute_python(self) -> str | None:
        override = os.getenv("YOUDUB_COMPUTE_PYTHON", "").strip()
        if override and Path(override).is_file():
            return override
        managed = self.managed_venv_python()
        if managed is not None:
            return str(managed)
        if os.getenv("YOUDUB_PACKAGED") != "1":
            return sys.executable
        return None

    def _probe_python_env(self, python_exec: str) -> dict[str, str | None]:
        """Inspect installed distribution versions in python_exec without importing heavy ML libs."""
        cache_key = python_exec
        if self._pkg_cache and self._pkg_cache[0] == cache_key:
            return self._pkg_cache[1]
        if Path(python_exec).resolve() == Path(sys.executable).resolve():
            result: dict[str, str | None] = {}
            all_dists = {
                dist
                for group in self._req_manifest["groups"].values()
                for dist in group["modules"].values()
            }
            for dist in all_dists:
                try:
                    result[dist] = importlib.metadata.version(dist)
                except importlib.metadata.PackageNotFoundError:
                    result[dist] = None
            self._pkg_cache = (cache_key, result)
            return result

        script = (
            "import importlib.metadata, json, sys; "
            "dists = json.loads(sys.argv[1]); "
            "out = {}; "
            "\nfor d in dists:\n"
            "  try: out[d] = importlib.metadata.version(d)\n"
            "  except importlib.metadata.PackageNotFoundError: out[d] = None\n"
            "print(json.dumps(out))"
        )
        all_dists = sorted(
            {dist for group in self._req_manifest["groups"].values() for dist in group["modules"].values()}
        )
        try:
            proc = subprocess.run(
                [python_exec, "-c", script, json.dumps(all_dists)],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
            parsed = json.loads(proc.stdout)
            if isinstance(parsed, dict):
                self._pkg_cache = (cache_key, parsed)
                return parsed
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        return {}

    def invalidate_probe_cache(self) -> None:
        self._pkg_cache = None
        self._ffmpeg_cache = None
        self._yt_dlp_version_cache = None

    def _verify_executable(self, binary: str, args: list[str]) -> bool:
        try:
            proc = subprocess.run(
                [binary, *args],
                capture_output=True,
                timeout=5,
            )
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def resolve_ffmpeg(self) -> tuple[str | None, str | None]:
        data = self._data_root()
        cache_key = f"{data}|{os.getenv('FFMPEG_PATH', '')}|{os.getenv('FFPROBE_PATH', '')}|{os.getenv('PATH', '')}"
        if self._ffmpeg_cache and self._ffmpeg_cache[0] == cache_key:
            return self._ffmpeg_cache[1]

        candidates: list[tuple[str | None, str | None]] = []
        env_ff = os.getenv("FFMPEG_PATH", "").strip()
        env_fp = os.getenv("FFPROBE_PATH", "").strip()
        if env_ff:
            candidates.append((env_ff, env_fp or shutil.which("ffprobe")))

        if data:
            ff_dir = data / "runtime" / "ffmpeg"
            ext = ".exe" if sys.platform == "win32" else ""
            plat = _platform_key()
            for ff_name, fp_name in (
                (f"ffmpeg{ext}", f"ffprobe{ext}"),
                (f"ffmpeg-{plat}", f"ffprobe-{plat}"),
            ):
                ff = ff_dir / ff_name
                fp = ff_dir / fp_name
                if ff.is_file() and fp.is_file():
                    candidates.append((str(ff), str(fp)))
            for ff in ff_dir.rglob(f"ffmpeg{ext}"):
                fp = ff.with_name(f"ffprobe{ext}")
                if ff.is_file() and fp.is_file():
                    candidates.append((str(ff), str(fp)))

        # Also check platform standard YouDub runtime dir if data_dir is elsewhere (dev convenience)
        if sys.platform == "darwin":
            std_dir = Path.home() / "Library" / "Application Support" / "YouDub" / "runtime" / "ffmpeg"
            if (std_dir / "ffmpeg").is_file() and (std_dir / "ffprobe").is_file():
                candidates.append((str(std_dir / "ffmpeg"), str(std_dir / "ffprobe")))

        sys_ff = shutil.which(ffmpeg_binary())
        sys_fp = shutil.which(ffprobe_binary())
        if sys_ff and sys_fp:
            candidates.append((sys_ff, sys_fp))

        resolved: tuple[str | None, str | None] = (None, None)
        for ff, fp in candidates:
            if ff and fp and Path(ff).is_file() and Path(fp).is_file():
                if self._verify_executable(ff, ["-version"]) and self._verify_executable(fp, ["-version"]):
                    resolved = (str(Path(ff).resolve()), str(Path(fp).resolve()))
                    break

        self._ffmpeg_cache = (cache_key, resolved)
        return resolved

    def yt_dlp_version(self) -> str | None:
        py = self.compute_python()
        if not py:
            return None
        if self._yt_dlp_version_cache and self._yt_dlp_version_cache[0] == py:
            return self._yt_dlp_version_cache[1]
        versions = self._probe_python_env(py)
        ver = versions.get("yt-dlp")
        self._yt_dlp_version_cache = (py, ver)
        return ver

    def yt_dlp_info(self) -> dict[str, Any]:
        ver = self.yt_dlp_version()
        checked = self._yt_dlp_latest_cache is not None
        latest = self._yt_dlp_latest_cache[1] if self._yt_dlp_latest_cache else None
        return {
            "version": ver,
            "installed": bool(ver),
            "latestVersion": latest,
            "updateAvailable": _is_newer_version(latest, ver) if ver else False,
            "checked": checked,
        }

    async def check_yt_dlp_update(self, *, force: bool = False) -> dict[str, Any]:
        if not force and self._yt_dlp_latest_cache is not None:
            ts, _ = self._yt_dlp_latest_cache
            if (time.monotonic() - ts) < _YTDLP_CHECK_TTL_SECONDS:
                return self.yt_dlp_info()

        prev_available = self.yt_dlp_info()["updateAvailable"]
        proxy = self.settings.config.proxy_url.strip() or None
        urls = (
            "https://pypi.org/pypi/yt-dlp/json",
            "https://pypi.tuna.tsinghua.edu.cn/pypi/yt-dlp/json",
        )
        latest: str | None = None
        for url in urls:
            try:
                async with httpx.AsyncClient(
                    proxy=proxy,
                    follow_redirects=True,
                    timeout=httpx.Timeout(4.0),
                    trust_env=False,
                    transport=self._transport,
                ) as client:
                    resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    cand = data.get("info", {}).get("version") if isinstance(data, dict) else None
                    if isinstance(cand, str) and cand.strip():
                        latest = cand.strip()
                        break
            except Exception:
                continue

        if latest is not None:
            self._yt_dlp_latest_cache = (time.monotonic(), latest)
            info = self.yt_dlp_info()
            if info["updateAvailable"] != prev_available:
                self._emit_updated(force=True)
            return info
        return self.yt_dlp_info()

    def update_yt_dlp(self) -> dict[str, Any]:
        py = self.compute_python()
        uv = self.find_uv()
        if not py:
            raise AppError(503, "PYTHON_NOT_READY", "Python environment is not ready yet.")
        prev_version = self.yt_dlp_version()
        cmd_base = (
            [uv, "pip", "install", "--python", py, "--upgrade", "yt-dlp"]
            if uv
            else [py, "-m", "pip", "install", "--upgrade", "yt-dlp"]
        )
        env = dict(os.environ)
        proxy = self.settings.config.proxy_url.strip()
        if proxy:
            env.setdefault("HTTP_PROXY", proxy)
            env.setdefault("HTTPS_PROXY", proxy)
        proc = subprocess.run(cmd_base, capture_output=True, text=True, timeout=180, env=env)
        if proc.returncode != 0:
            mirror_cmd = [*cmd_base, "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"]
            proc = subprocess.run(mirror_cmd, capture_output=True, text=True, timeout=180, env=env)
        if proc.returncode != 0:
            raise AppError(
                502,
                "YTDLP_UPDATE_FAILED",
                f"Failed to update yt-dlp: {(proc.stderr or proc.stdout).strip()[-400:]}",
            )
        self.invalidate_probe_cache()
        version = self.yt_dlp_version()
        if version:
            self._yt_dlp_latest_cache = (time.monotonic(), version)
        self._emit_updated(force=True)
        return {
            "ok": True,
            "version": version,
            "previousVersion": prev_version,
            "updated": bool(version and version != prev_version),
        }

    # ------------------------------------------------------------------
    # Model directory & file resolution (reusing existing disk weights)
    # ------------------------------------------------------------------

    def _model_spec(self, download_id: str) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
        """Resolve a model id ('whisper', 'whisper:small', 'voxcpm', 'demucs', 'qwen')."""
        base_id, _, variant = download_id.partition(":")
        spec = next((m for m in self._models_manifest if m["id"] == base_id), None)
        if spec is None:
            raise AppError(404, "RESOURCE_NOT_FOUND", f"Unknown model resource: {download_id}")
        variants = spec.get("variants")
        if isinstance(variants, dict):
            chosen_variant = variant or spec.get("variant") or "large-v3-turbo"
            files = variants.get(chosen_variant)
            if not files:
                raise AppError(404, "RESOURCE_NOT_FOUND", f"Unknown variant {chosen_variant!r} for {base_id}")
            return spec, chosen_variant, files
        return spec, str(spec.get("variant") or ""), spec.get("files", [])

    def model_dir(self, base_id: str) -> Path | None:
        spec = next((m for m in self._models_manifest if m["id"] == base_id), None)
        if spec is None:
            return None
        env_key = spec.get("env", "")
        env_val = os.getenv(env_key, "").strip() if env_key else ""
        if env_val:
            return Path(env_val).expanduser().resolve()
        data = self._data_root()
        if data is None:
            return None
        return data / "models" / spec["directory"]

    def _voxcpm_files_present(self, root: Path) -> bool:
        def exists(name: str) -> bool:
            p = root / name
            return p.is_file() and p.stat().st_size > 0

        groups = (
            ("config.json",),
            ("tokenizer_config.json",),
            ("tokenizer.json", "tokenizer.model"),
            ("model.safetensors", "pytorch_model.bin"),
            ("audiovae.safetensors", "audiovae.pth"),
        )
        return all(any(exists(name) for name in choices) for choices in groups)

    def is_model_ready(self, base_id: str, variant: str | None = None) -> bool:
        root = self.model_dir(base_id)
        if root is None or not root.is_dir():
            return False
        if base_id == "voxcpm":
            return self._voxcpm_files_present(root)
        download_id = f"{base_id}:{variant}" if variant and base_id == "whisper" else base_id
        try:
            _, _, files = self._model_spec(download_id)
        except AppError:
            return False
        return all((root / f["path"]).is_file() and (root / f["path"]).stat().st_size > 0 for f in files)

    def installed_whisper_variants(self) -> list[str]:
        spec = next((m for m in self._models_manifest if m["id"] == "whisper"), None)
        if not spec or not isinstance(spec.get("variants"), dict):
            return []
        return [v for v in spec["variants"] if self.is_model_ready("whisper", v)]

    def model_disk_bytes(self, base_id: str, variant: str | None = None) -> int:
        root = self.model_dir(base_id)
        if root is None or not root.is_dir():
            return 0
        download_id = f"{base_id}:{variant}" if variant and base_id == "whisper" else base_id
        try:
            _, _, files = self._model_spec(download_id)
        except AppError:
            return 0
        total = 0
        for item in files:
            path = root / item["path"]
            if path.is_file():
                total += path.stat().st_size
        return total

    def total_models_disk_bytes(self) -> int:
        data = self._data_root()
        if data is None:
            return 0
        models_root = data / "models"
        if not models_root.is_dir():
            return 0
        total = 0
        for path in models_root.rglob("*"):
            if path.is_file() and not path.name.endswith(".part"):
                total += path.stat().st_size
        return total

    def _storage_summary(self) -> dict[str, Any]:
        data = self._data_root()
        return {
            "dataDir": str(data) if data is not None else None,
            "modelsDir": str(data / "models") if data is not None else None,
            "diskBytes": self.total_models_disk_bytes(),
            "proxyConfigured": bool(self.settings.config.proxy_url.strip()),
        }

    def _llm_ready(self) -> bool:
        return any(
            bool(self.settings.provider_view(provider)["available"])
            for provider in self.settings.config.llm_providers
        )

    def child_process_env(self) -> dict[str, str]:
        """Environment passed to child media/ML processes (data_dir-scoped)."""
        env = dict(os.environ)
        env["YOUDUB_MANAGED_RUNTIME"] = "1"
        existing_py_path = env.get("PYTHONPATH", "").strip()
        repo_str = str(REPO_ROOT)
        env["PYTHONPATH"] = f"{repo_str}{os.pathsep}{existing_py_path}" if existing_py_path else repo_str
        data = self._data_root()
        if data is not None:
            env["YOUDUB_DESKTOP_DATA_DIR"] = str(data)
            for spec in self._models_manifest:
                env_key = spec.get("env")
                if env_key and not env.get(env_key):
                    env[env_key] = str(data / "models" / spec["directory"])
        ff, fp = self.resolve_ffmpeg()
        if ff:
            env["FFMPEG_PATH"] = ff
            ff_dir = str(Path(ff).parent)
            env["PATH"] = f"{ff_dir}{os.pathsep}{env.get('PATH', '')}"
        if fp:
            env["FFPROBE_PATH"] = fp
        return env

    # ------------------------------------------------------------------
    # Setup & Inventory / Check projections
    # ------------------------------------------------------------------

    def _environment_steps(self) -> list[dict[str, Any]]:
        py = self.compute_python()
        ff, fp = self.resolve_ffmpeg()
        installed = self._probe_python_env(py) if py else {}
        base_missing = [
            dist for dist in self._req_manifest["groups"]["media"]["modules"].values() if not installed.get(dist)
        ] if py else ["media"]
        accel = accelerator_status()

        def step(step_id: str, name: str, ready: bool, detail: str | None = None) -> dict[str, Any]:
            live = self._state.environment.get(step_id)
            if live and live.status in {"running", "failed"}:
                out: dict[str, Any] = {
                    "id": step_id,
                    "name": name,
                    "status": live.status,
                    "detail": live.error or live.detail or detail,
                    "phase": live.phase,
                }
                if live.total > 0 or live.received > 0:
                    out["progress"] = {"received": live.received, "total": live.total, "speed": live.speed}
                return out
            return {
                "id": step_id,
                "name": name,
                "status": "ready" if ready else "pending",
                "detail": detail,
            }

        return [
            step("python", "Python 3.12", bool(py), py or "Compute venv has not been created yet."),
            step("ffmpeg", "FFmpeg", bool(ff and fp), ff or "FFmpeg binary not found."),
            step(
                "dependencies",
                "Python 依赖",
                bool(py) and not base_missing,
                None if not base_missing else f"Missing packages: {', '.join(base_missing)}",
            ),
            step(
                "acceleration",
                "计算加速",
                bool(py),
                accel.get("plan", {}).get("detail") or f"Backend: {accel.get('plan', {}).get('backend', 'cpu')}",
            ),
        ]

    def _model_status_dict(self, base_id: str, variant: str | None = None) -> dict[str, Any]:
        spec = next(m for m in self._models_manifest if m["id"] == base_id)
        chosen_variant = variant or str(spec.get("variant") or "")
        download_key = f"{base_id}:{chosen_variant}" if base_id == "whisper" else base_id
        _, _, files = self._model_spec(download_key)
        expected_total = sum(int(f.get("size") or 0) for f in files)
        ready = self.is_model_ready(base_id, chosen_variant if base_id == "whisper" else None)

        live = self._state.models.get(download_key) or (self._state.models.get("whisper") if base_id == "whisper" else None)
        if live and live.status in {"downloading", "paused", "failed"}:
            status = live.status
            received = live.received
            total = live.total or expected_total
            speed = live.speed if status == "downloading" else 0.0
            error = live.error
            source = live.source
        else:
            status = "ready" if ready else "pending"
            received = expected_total if ready else 0
            total = expected_total
            speed = 0.0
            error = None
            source = None

        return {
            "id": download_key if (base_id == "whisper" and chosen_variant and chosen_variant != spec.get("variant")) else base_id,
            "downloadId": download_key,
            "name": spec["name"],
            "variant": chosen_variant,
            "purpose": spec["purpose"],
            "status": status,
            "received": received,
            "total": total,
            "speed": speed,
            "diskBytes": self.model_disk_bytes(base_id, chosen_variant if base_id == "whisper" else None),
            "source": source,
            "error": error,
        }

    def _all_model_dicts(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for spec in self._models_manifest:
            result.append(self._model_status_dict(spec["id"], spec.get("variant")))
        return result

    def _whisper_variants_payload(self) -> list[dict[str, Any]]:
        spec = next(m for m in self._models_manifest if m["id"] == "whisper")
        variants = spec.get("variants") or {}
        installed = set(self.installed_whisper_variants())
        out: list[dict[str, Any]] = []
        for vid, files in variants.items():
            key = f"whisper:{vid}"
            live = self._state.models.get(key)
            status = live.status if live and live.status in {"downloading", "paused", "failed"} else ("ready" if vid in installed else "pending")
            expected_total = sum(int(f.get("size") or 0) for f in files)
            disk_bytes = self.model_disk_bytes("whisper", vid)
            out.append(
                {
                    "id": vid,
                    "downloadId": key,
                    "recommended": vid == "large-v3-turbo",
                    "status": status,
                    "installed": vid in installed,
                    "received": live.received if live else (disk_bytes or expected_total if vid in installed else 0),
                    "total": (live.total if live and live.total else expected_total),
                    "speed": live.speed if live and status == "downloading" else 0.0,
                    "source": live.source if live else None,
                    "phase": live.phase if live else None,
                    "diskBytes": disk_bytes,
                    "error": live.error if live else None,
                }
            )
        return out

    def setup_state(self) -> dict[str, Any]:
        env_steps = self._environment_steps()
        models = self._all_model_dicts()
        data = self._data_root()
        if data is None:
            return {
                "phase": "installation",
                "platform": sys.platform,
                "arch": "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else platform.machine().lower(),
                "version": APP_VERSION,
                "osVersion": platform.release(),
                "homeDir": str(Path.home()),
                "environment": env_steps,
                "models": models,
                "canRetry": True,
                "installation": {"required": True, "path": str(default_data_dir())},
            }
        # Lightweight first-run: choosing data_dir immediately unlocks the Workbench!
        return {
            "phase": "ready",
            "platform": sys.platform,
            "arch": "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else platform.machine().lower(),
            "version": APP_VERSION,
            "osVersion": platform.release(),
            "homeDir": str(Path.home()),
            "environment": env_steps,
            "models": models,
            "canRetry": True,
        }

    def handle_setup_post(self, body: dict[str, Any]) -> dict[str, Any]:
        action = body.get("action")
        if action == "configure":
            raw_path = str(body.get("path") or "").strip()
            p = Path(raw_path).expanduser()
            if not p.is_absolute():
                raise AppError(422, "INVALID_DIRECTORY", "Please choose an absolute directory path.")
            self.settings.configure_data_dir(str(p))
            self.invalidate_probe_cache()
            self.events.publish("settings.updated", self.settings.settings_view())
            self._emit_updated(force=True)
            return self.setup_state()
        if action == "prepare":
            self.start_prepare(selections=body.get("selections"), resource_ids=body.get("resourceIds"))
            return self.setup_state()
        if action in {"pause", "resume", "retry"}:
            self.perform_action(action, body.get("id"))
            return self.setup_state()
        raise AppError(400, "INVALID_ACTION", f"Unsupported setup action: {action!r}")

    def _missing_groups_for_provider(self, provider_id: str) -> list[str]:
        py = self.compute_python()
        p_info = self._req_manifest["providers"].get(provider_id)
        if not p_info:
            return []
        groups = list(p_info.get("dependencyGroups", []))
        if not py:
            return groups
        installed = self._probe_python_env(py)
        missing: list[str] = []
        for g in groups:
            modules = self._req_manifest["groups"].get(g, {}).get("modules", {})
            for dist in modules.values():
                if not installed.get(dist):
                    missing.append(dist)
        return sorted(set(missing))

    def _requirement_for_selection(self, sel: dict[str, Any]) -> dict[str, Any]:
        provider_id = str(sel.get("providerId") or "")
        model = sel.get("model")

        # LLM translation providers check Settings config + API key
        llm = self.settings.get_provider(provider_id)
        if llm is not None:
            view = self.settings.provider_view(llm)
            ready = bool(view["available"])
            return {
                "providerId": provider_id,
                **({"model": model} if model else {}),
                "resourceId": provider_id,
                "name": llm.name,
                "ready": ready,
                "automatic": False,
                "configurationRequired": not ready,
                "missingPackages": [],
                **({} if ready else {"reason": "Provider connection is not configured."}),
            }

        if provider_id in {"youdub.media", "youdub.download"}:
            ff, fp = self.resolve_ffmpeg()
            missing_pkgs = self._missing_groups_for_provider(provider_id)
            ready = bool(ff and fp) and not missing_pkgs
            reasons: list[str] = []
            if not (ff and fp):
                reasons.append("FFmpeg is missing.")
            if missing_pkgs:
                reasons.append(f"Missing Python packages: {', '.join(missing_pkgs)}")
            return {
                "providerId": provider_id,
                "resourceId": "ffmpeg" if not (ff and fp) else provider_id,
                "name": "FFmpeg" if provider_id == "youdub.media" else "yt-dlp",
                "ready": ready,
                "automatic": True,
                "missingPackages": missing_pkgs,
                **({"reason": " ".join(reasons)} if reasons else {}),
            }

        if provider_id in {"whisper", "voxcpm", "demucs", "qwen", "qwen_forced_aligner"}:
            base_id = "qwen" if provider_id in {"qwen", "qwen_forced_aligner"} else provider_id
            ff, fp = self.resolve_ffmpeg()
            req_key = "qwen_forced_aligner" if base_id == "qwen" else base_id
            missing_pkgs = self._missing_groups_for_provider(req_key)
            chosen_model = str(model or ("large-v3-turbo" if base_id == "whisper" else ""))
            weights_ready = self.is_model_ready(base_id, chosen_model if base_id == "whisper" else None)
            ready = bool(ff and fp) and not missing_pkgs and weights_ready
            reasons = []
            if not (ff and fp):
                reasons.append("FFmpeg is missing.")
            if missing_pkgs:
                reasons.append(f"Missing packages: {', '.join(missing_pkgs)}")
            if not weights_ready:
                reasons.append(f"Model {chosen_model or base_id} weights not downloaded.")
            download_id = f"whisper:{chosen_model}" if base_id == "whisper" else base_id
            return {
                "providerId": provider_id,
                **({"model": chosen_model} if chosen_model else {}),
                "resourceId": download_id if not weights_ready else base_id,
                "name": next(m["name"] for m in self._models_manifest if m["id"] == base_id),
                "downloadId": download_id,
                "ready": ready,
                "automatic": True,
                "missingPackages": missing_pkgs,
                **({"reason": " ".join(reasons)} if reasons else {}),
            }

        return {
            "providerId": provider_id,
            **({"model": model} if model else {}),
            "ready": True,
            "automatic": True,
            "missingPackages": [],
        }

    def _build_entries(
        self,
        env_steps: list[dict[str, Any]],
        models: list[dict[str, Any]],
        requirements: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for step in env_steps:
            status = "preparing" if step["status"] == "running" else step["status"]
            actions: list[str] = []
            if status == "pending":
                actions = ["prepare"]
            elif status == "failed":
                actions = ["retry"]
            entries.append(
                {
                    "id": step["id"],
                    "name": step["name"],
                    "group": "environment",
                    "status": status,
                    "phase": step.get("phase"),
                    "actions": actions,
                    "dependencies": [],
                    "detail": step.get("detail"),
                    "error": step.get("detail") if status == "failed" else None,
                    **({"progress": step["progress"]} if step.get("progress") else {}),
                }
            )
        # Add yt-dlp entry under environment cleanly
        yt_ver = self.yt_dlp_version()
        entries.append(
            {
                "id": "youdub.download",
                "name": "yt-dlp",
                "variant": yt_ver or "",
                "group": "environment",
                "status": "ready" if yt_ver else "pending",
                "actions": [] if yt_ver else ["prepare"],
                "dependencies": ["python"],
                "detail": f"yt-dlp {yt_ver}" if yt_ver else "yt-dlp not installed in compute runtime.",
            }
        )
        for model in models:
            status = model["status"]
            if status == "downloading":
                entry_status = "preparing"
                actions = ["pause"]
                phase = "downloading"
            elif status == "paused":
                entry_status = "paused"
                actions = ["resume"]
                phase = "downloading"
            elif status == "failed":
                entry_status = "failed"
                actions = ["retry"]
                phase = None
            elif status == "ready":
                entry_status = "ready"
                actions = []
                phase = None
            else:
                entry_status = "pending"
                actions = ["prepare"]
                phase = None
            entry: dict[str, Any] = {
                "id": model["id"],
                "downloadId": model.get("downloadId", model["id"]),
                "name": model["name"],
                "variant": model.get("variant", ""),
                "group": "model",
                "status": entry_status,
                "phase": phase,
                "actions": actions,
                "dependencies": [],
                "source": model.get("source"),
                "error": model.get("error"),
            }
            if model.get("total", 0) > 0 or model.get("received", 0) > 0:
                entry["progress"] = {
                    "received": model.get("received", 0),
                    "total": model.get("total", 0),
                    "speed": model.get("speed", 0),
                }
            entries.append(entry)
        return entries

    def inventory(self) -> dict[str, Any]:
        env_steps = self._environment_steps()
        models = self._all_model_dicts()
        items = [
            {"providerId": "youdub.media", "label": "FFmpeg", "automatic": True},
            {"providerId": "whisper", "model": "large-v3-turbo", "label": "Whisper", "automatic": True, "downloadId": "whisper:large-v3-turbo"},
            {"providerId": "voxcpm", "model": "VoxCPM2", "label": "VoxCPM2", "automatic": True, "downloadId": "voxcpm"},
            {"providerId": "demucs", "model": "htdemucs", "label": "Demucs", "automatic": True, "downloadId": "demucs"},
            {"providerId": "qwen", "model": "Qwen3-ForcedAligner-0.6B-hf", "label": "Qwen3 Aligner", "automatic": True, "downloadId": "qwen"},
        ]
        entries = self._build_entries(env_steps, models, [])
        active_prep = (
            {"selections": [], "status": self._state.status, "error": self._state.error}
            if self._state.status in {"preparing", "failed"}
            else None
        )
        return {
            "version": APP_VERSION,
            "platform": sys.platform,
            "arch": "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else platform.machine().lower(),
            "osVersion": platform.release(),
            "homeDir": str(Path.home()),
            "environment": env_steps,
            "items": items,
            "models": models,
            "whisperVariants": self._whisper_variants_payload(),
            "ytDlp": self.yt_dlp_info(),
            "storage": self._storage_summary(),
            "llmReady": self._llm_ready(),
            "entries": entries,
            "resources": {
                "status": self._state.status,
                "environment": env_steps,
                "models": models,
                "entries": entries,
                "error": self._state.error,
                **({"activePreparation": active_prep} if active_prep else {}),
            },
        }

    def check(self, selections: list[dict[str, Any]]) -> dict[str, Any]:
        requirements = [self._requirement_for_selection(sel) for sel in selections]
        all_ready = all(req["ready"] for req in requirements)
        env_steps = self._environment_steps()

        # Project only models matching the requested selections when checking a workflow,
        # or all models when inventory checks everything.
        selected_models: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for sel in selections:
            pid = str(sel.get("providerId") or "")
            base_id = "qwen" if pid in {"qwen", "qwen_forced_aligner"} else pid
            if any(m["id"] == base_id for m in self._models_manifest):
                variant = str(sel.get("model") or "") if base_id == "whisper" else None
                key = f"{base_id}:{variant}" if variant else base_id
                if key not in seen_ids:
                    seen_ids.add(key)
                    selected_models.append(self._model_status_dict(base_id, variant))
        if not selected_models:
            selected_models = self._all_model_dicts()

        entries = self._build_entries(env_steps, selected_models, requirements)
        status = (
            "preparing"
            if self._state.status == "preparing"
            else "failed"
            if self._state.status == "failed"
            else "ready"
            if all_ready
            else "missing"
        )
        return {
            "status": status,
            "selections": selections,
            "requirements": requirements,
            "environment": env_steps,
            "models": selected_models,
            "entries": entries,
            "whisperVariants": self._whisper_variants_payload(),
            "ytDlp": self.yt_dlp_info(),
            "storage": self._storage_summary(),
            "llmReady": self._llm_ready(),
            **({"error": self._state.error} if self._state.error else {}),
            **(
                {"activePreparation": {"selections": selections, "status": self._state.status, "error": self._state.error}}
                if self._state.status in {"preparing", "failed"}
                else {}
            ),
        }

    def selections_for_document(self, document: dict[str, Any]) -> list[dict[str, Any]]:
        selections: list[dict[str, Any]] = []
        seen: set[tuple[str, str | None]] = set()
        for node in document.get("nodes", []):
            provider = node.get("provider") or {}
            pid = str(provider.get("id") or "")
            if node.get("type") == "youdub.align" and pid in {"qwen", "qwen_forced_aligner"}:
                align_lang = str((node.get("config") or {}).get("targetLanguage") or "zh")
                if align_lang not in {"zh", "en"}:
                    continue
            model = provider.get("model")
            key = (pid, str(model) if model else None)
            if pid and key not in seen:
                seen.add(key)
                selections.append({"providerId": pid, **({"model": model} if model else {})})
        return selections

    def check_document(self, document: dict[str, Any]) -> dict[str, Any]:
        return self.check(self.selections_for_document(document))

    # ------------------------------------------------------------------
    # Async preparation, downloads, pause/resume/retry
    # ------------------------------------------------------------------

    def _resolve_prepare_targets(
        self,
        *,
        selections: list[dict[str, Any]] | None = None,
        resource_ids: list[str] | None = None,
    ) -> list[str]:
        targets: list[str] = []
        if resource_ids:
            targets.extend(str(r) for r in resource_ids)
        elif selections:
            for req in [self._requirement_for_selection(s) for s in selections]:
                if req.get("ready"):
                    continue
                if not req.get("automatic"):
                    continue
                if req.get("downloadId"):
                    targets.append(str(req["downloadId"]))
                elif req.get("resourceId"):
                    targets.append(str(req["resourceId"]))
        else:
            targets.extend(["python", "ffmpeg", "dependencies", "whisper:large-v3-turbo", "voxcpm", "demucs", "qwen"])
        return targets

    def start_prepare(
        self,
        *,
        selections: list[dict[str, Any]] | None = None,
        resource_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        data = self._data_root()
        if data is None:
            raise AppError(503, "SETUP_REQUIRED", "Configure workspace data directory first.")
        targets = self._resolve_prepare_targets(selections=selections, resource_ids=resource_ids)
        if self._prep_task is not None and not self._prep_task.done():
            for item in targets:
                if item not in self._pending_targets:
                    self._pending_targets.append(item)
            return self.check(selections or [])

        self._state.status = "preparing"
        self._state.error = None
        loop = asyncio.get_running_loop()
        self._prep_task = loop.create_task(self._run_preparation(targets))
        self._emit_updated(force=True)
        return self.check(selections or [])

    def perform_action(self, action: str, resource_id: str | None = None) -> dict[str, Any]:
        if action == "pause":
            if resource_id is None:
                self._pending_targets.clear()
            else:
                self._pending_targets = [
                    t for t in self._pending_targets if t != resource_id and not t.startswith(f"{resource_id}:")
                ]
            for key, st in self._state.models.items():
                if resource_id is None or key == resource_id or key.startswith(f"{resource_id}:"):
                    st.pause_requested = True
                    if st.status == "downloading":
                        st.status = "paused"
            self._emit_updated(force=True)
            return self.inventory()
        if action in {"resume", "retry"}:
            targets = [resource_id] if resource_id else list(self._state.models.keys()) or None
            for key in list(self._state.models.keys()):
                if resource_id is None or key == resource_id or key.startswith(f"{resource_id}:"):
                    self._state.models[key].pause_requested = False
                    self._state.models[key].error = None
            return self.start_prepare(resource_ids=targets)
        if action == "delete":
            if not resource_id:
                raise AppError(400, "INVALID_ACTION", "resourceId is required for delete.")
            if self._prep_task is not None and not self._prep_task.done():
                raise AppError(409, "RESOURCE_BUSY", "Cannot delete model weights while preparation is active.")
            spec, chosen_variant, files = self._model_spec(resource_id)
            target_dir = self.model_dir(spec["id"])
            if target_dir and target_dir.is_dir():
                for file_spec in files:
                    file_path = target_dir / file_spec["path"]
                    file_path.unlink(missing_ok=True)
                    file_path.with_name(file_path.name + ".part").unlink(missing_ok=True)
            download_key = f"{spec['id']}:{chosen_variant}" if spec["id"] == "whisper" else spec["id"]
            self._state.models.pop(download_key, None)
            if spec["id"] == "whisper" and chosen_variant == spec.get("variant"):
                self._state.models.pop("whisper", None)
            self.invalidate_probe_cache()
            self._emit_updated(force=True)
            return self.inventory()
        raise AppError(400, "INVALID_ACTION", f"Unsupported resource action: {action!r}")

    async def _run_preparation(self, initial_targets: list[str]) -> None:
        queue = list(initial_targets)
        try:
            while queue:
                targets = queue
                queue = []
                # 1. Ensure Python venv + FFmpeg + Python packages if requested or missing
                need_env = any(t in {"python", "ffmpeg", "dependencies", "youdub.download", "youdub.media"} for t in targets) or any(
                    not t.startswith("whisper") and t not in {"voxcpm", "demucs", "qwen"} for t in targets
                )
                if need_env or self.resolve_ffmpeg() == (None, None) or self.compute_python() is None:
                    await self._prepare_environment()

                # 2. Download requested model weights
                model_targets = [
                    t for t in targets if t.startswith("whisper") or t in {"voxcpm", "demucs", "qwen"}
                ]
                for download_id in model_targets:
                    if self._state.models.get(download_id) and self._state.models[download_id].pause_requested:
                        continue
                    await self._download_model(download_id)

                if self._pending_targets:
                    queue.extend(self._pending_targets)
                    self._pending_targets.clear()

            any_paused = any(st.status == "paused" for st in self._state.models.values())
            any_failed = any(st.status == "failed" for st in self._state.models.values()) or any(
                st.status == "failed" for st in self._state.environment.values()
            )
            self._state.status = "failed" if any_failed else "missing" if any_paused else "ready"
        except Exception as exc:
            self._state.status = "failed"
            self._state.error = str(exc)
        finally:
            self._pending_targets.clear()
            self._emit_updated(force=True)

    async def _prepare_environment(self) -> None:
        data = self._data_root()
        assert data is not None
        # Check FFmpeg
        ff, fp = self.resolve_ffmpeg()
        if not (ff and fp):
            st = self._state.environment.setdefault("ffmpeg", DownloadProgressState())
            st.status = "running"
            st.phase = "downloading"
            self._emit_updated(force=True)
            try:
                await self._install_ffmpeg(data / "runtime" / "ffmpeg", st)
                st.status = "ready"
                st.phase = None
            except Exception as exc:
                st.status = "failed"
                st.error = str(exc)
                raise
            finally:
                self.invalidate_probe_cache()

        # Check compute venv
        if self.compute_python() is None:
            st = self._state.environment.setdefault("python", DownloadProgressState())
            st.status = "running"
            st.phase = "installing"
            self._emit_updated(force=True)
            try:
                uv = self.find_uv()
                if not uv:
                    raise RuntimeError("uv executable not found; install uv or bundled desktop runtime.")
                venv_dir = data / "runtime" / "venv"
                py_seed = sys.executable if sys.version_info[:2] == (3, 12) else "3.12"
                proc = await asyncio.create_subprocess_exec(
                    uv, "venv", "--python", py_seed, str(venv_dir),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(f"uv venv failed: {stderr.decode(errors='replace')}")
                st.status = "ready"
                st.phase = None
            except Exception as exc:
                st.status = "failed"
                st.error = str(exc)
                raise
            finally:
                self.invalidate_probe_cache()

        # Check missing packages in compute python
        py = self.compute_python()
        if py:
            missing = []
            for group in ("base", "media", "download", "whisper", "demucs", "voxcpm", "qwen_forced_aligner"):
                for dist in self._req_manifest["groups"][group]["modules"].values():
                    if not self._probe_python_env(py).get(dist):
                        missing.append(group)
                        break
            if missing:
                st = self._state.environment.setdefault("dependencies", DownloadProgressState())
                st.status = "running"
                st.phase = "installing"
                self._emit_updated(force=True)
                try:
                    await self._install_python_dependencies(py, missing)
                    st.status = "ready"
                    st.phase = None
                except Exception as exc:
                    st.status = "failed"
                    st.error = str(exc)
                    raise
                finally:
                    self.invalidate_probe_cache()

    async def _install_ffmpeg(self, target_dir: Path, state: DownloadProgressState) -> None:
        plat = _platform_key()
        assets = self._runtime_manifest.get("ffmpeg", {}).get(plat)
        if not assets:
            raise RuntimeError(f"No pinned FFmpeg build for platform {plat}")
        target_dir.mkdir(parents=True, exist_ok=True)
        for asset in assets:
            if plat == "win32-x64":
                archive = target_dir / asset["path"]
                await self._download_asset_with_mirrors(asset, archive, state)
                if archive.suffix == ".zip":
                    with zipfile.ZipFile(archive) as zf:
                        zf.extractall(target_dir)
                else:
                    with tarfile.open(archive) as tf:
                        tf.extractall(target_dir)
                break
            dest = target_dir / ("ffmpeg" if "ffmpeg" in asset["path"] else "ffprobe")
            await self._download_asset_with_mirrors(asset, dest, state)
            if os.name == "posix":
                dest.chmod(stat.S_IRWXU)

    async def _install_python_dependencies(self, python_exec: str, groups: list[str]) -> None:
        uv = self.find_uv()
        req_files = [str(REQUIREMENTS_DIR / f"{g}.txt") for g in groups if (REQUIREMENTS_DIR / f"{g}.txt").is_file()]
        args: list[str] = []
        for rf in req_files:
            args.extend(["-r", rf])
        plan = installation_plan(hardware())
        extra_args: list[str] = []
        if plan.get("findLinks"):
            extra_args.extend(["--find-links", str(plan["findLinks"])])
        cmd = (
            [uv, "pip", "install", "--python", python_exec, *args, *extra_args]
            if uv
            else [python_exec, "-m", "pip", "install", *args, *extra_args]
        )
        env = dict(os.environ)
        proxy = self.settings.config.proxy_url.strip()
        if proxy:
            env.setdefault("HTTP_PROXY", proxy)
            env.setdefault("HTTPS_PROXY", proxy)
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            mirror_cmd = [*cmd, "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"]
            proc = await asyncio.create_subprocess_exec(
                *mirror_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
            )
            _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"Dependency install failed: {stderr.decode(errors='replace')[-600:]}")

    async def _download_model(self, download_id: str) -> None:
        spec, variant, files = self._model_spec(download_id)
        base_id = spec["id"]
        target_dir = self.model_dir(base_id)
        if target_dir is None:
            raise AppError(503, "SETUP_REQUIRED", "Configure workspace data directory first.")
        target_dir.mkdir(parents=True, exist_ok=True)
        total_expected = sum(int(f.get("size") or 0) for f in files)
        state = self._state.models.setdefault(download_id, DownloadProgressState(total=total_expected))
        state.status = "downloading"
        state.phase = "downloading"
        state.error = None
        state.pause_requested = False
        self._emit_updated(force=True)

        cumulative_done = 0
        try:
            for file_spec in files:
                dest = target_dir / file_spec["path"]
                if dest.is_file() and dest.stat().st_size > 0:
                    expected_sha = str(file_spec.get("sha256") or "")
                    if not expected_sha or _sha256_file(dest) == expected_sha:
                        cumulative_done += dest.stat().st_size
                        state.received = cumulative_done
                        continue
                await self._download_asset_with_mirrors(
                    file_spec,
                    dest,
                    state,
                    base_received=cumulative_done,
                )
                cumulative_done += dest.stat().st_size
            state.status = "ready"
            state.phase = None
            state.speed = 0.0
        except _DownloadPaused:
            state.status = "paused"
            state.phase = "downloading"
            state.speed = 0.0
        except Exception as exc:
            state.status = "failed"
            state.phase = None
            state.speed = 0.0
            state.error = str(exc)
        finally:
            self._emit_updated(force=True)

    async def _download_asset_with_mirrors(
        self,
        asset: dict[str, Any],
        dest: Path,
        state: DownloadProgressState,
        *,
        base_received: int = 0,
    ) -> None:
        urls = [str(asset["url"]), *(str(m) for m in asset.get("mirrors", []))]
        expected_sha = str(asset.get("sha256") or "")
        part_path = dest.with_name(dest.name + ".part")
        part_path.parent.mkdir(parents=True, exist_ok=True)
        proxy = self.settings.config.proxy_url.strip() or None
        last_exc: Exception | None = None

        for candidate_url in urls:
            host = urllib.parse.urlsplit(candidate_url).hostname or candidate_url
            state.source = host
            for reset_range in (False, True):
                if reset_range:
                    part_path.unlink(missing_ok=True)
                existing_bytes = part_path.stat().st_size if part_path.is_file() else 0
                headers = {"Range": f"bytes={existing_bytes}-"} if existing_bytes > 0 else {}
                try:
                    async with httpx.AsyncClient(
                        proxy=proxy,
                        follow_redirects=True,
                        timeout=httpx.Timeout(connect=15.0, read=60.0, write=30.0, pool=15.0),
                        trust_env=False,
                        transport=self._transport,
                    ) as client:
                        async with client.stream("GET", candidate_url, headers=headers) as resp:
                            if resp.status_code == 416 and not reset_range:
                                continue
                            if resp.status_code >= 400:
                                raise RuntimeError(f"HTTP {resp.status_code} downloading from {host}")

                            append = resp.status_code == 206 and existing_bytes > 0
                            mode = "ab" if append else "wb"
                            offset = existing_bytes if append else 0

                            content_len = int(resp.headers.get("content-length") or 0)
                            if content_len > 0 and state.total == 0:
                                state.total = base_received + offset + content_len

                            last_tick = time.monotonic()
                            bytes_since_tick = 0
                            with part_path.open(mode) as handle:
                                async for chunk in resp.aiter_bytes(chunk_size=128 * 1024):
                                    if state.pause_requested:
                                        raise _DownloadPaused()
                                    handle.write(chunk)
                                    offset += len(chunk)
                                    bytes_since_tick += len(chunk)
                                    now = time.monotonic()
                                    elapsed = now - last_tick
                                    if elapsed >= 0.25:
                                        state.speed = bytes_since_tick / elapsed
                                        state.received = base_received + offset
                                        last_tick = now
                                        bytes_since_tick = 0
                                        self._emit_updated()
                            state.received = base_received + offset

                    if expected_sha:
                        state.phase = "verifying"
                        self._emit_updated(force=True)
                        actual = _sha256_file(part_path)
                        if actual != expected_sha:
                            part_path.unlink(missing_ok=True)
                            raise RuntimeError(
                                f"SHA256 mismatch for {dest.name}: expected {expected_sha[:12]}, got {actual[:12]}"
                            )
                    os.replace(part_path, dest)
                    return
                except _DownloadPaused:
                    raise
                except Exception as exc:
                    last_exc = exc
                    break
        raise RuntimeError(f"All download sources failed for {dest.name}: {last_exc}")


class _DownloadPaused(Exception):
    pass
