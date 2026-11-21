"""Application configuration and OS-backed secret storage."""

from __future__ import annotations

import base64
import json
import os
import stat
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, Field

from .errors import AppError

ProtocolKind = Literal["openai", "anthropic", "gemini"]
ThemeMode = Literal["system", "light", "dark"]
UiLanguage = Literal["zh", "en", "ja"]


class LLMProviderConfig(BaseModel):
    id: str
    name: str
    protocol: ProtocolKind = "openai"
    preset: str = "custom"
    base_url: str = ""
    default_model: str = ""
    models: list[str] = Field(default_factory=list)
    enabled: bool = True


class AppConfig(BaseModel):
    ui_language: UiLanguage = "zh"
    theme: ThemeMode = "system"
    data_dir: str | None = None
    proxy_url: str = ""
    llm_providers: list[LLMProviderConfig] = Field(default_factory=list)


def default_config_dir() -> Path:
    override = os.getenv("YOUDUB_CONFIG_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "YouDub"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(appdata) / "YouDub"
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(xdg) / "youdub"


def default_data_dir() -> Path:
    override = os.getenv("YOUDUB_DATA_DIR", "").strip() or os.getenv("YOUDUB_DESKTOP_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return (Path.home() / "Movies" / "YouDub").resolve()
    if sys.platform == "win32":
        return (Path.home() / "Videos" / "YouDub").resolve()
    return (Path.home() / "YouDub").resolve()


def _default_providers() -> list[LLMProviderConfig]:
    return [
        LLMProviderConfig(
            id="openai",
            name="DeepSeek / OpenAI",
            protocol="openai",
            preset="deepseek",
            base_url="https://api.deepseek.com/v1",
            default_model="deepseek-chat",
            models=["deepseek-chat", "deepseek-reasoner"],
            enabled=True,
        )
    ]


def _atomic_write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            path.parent.chmod(0o700)
        except OSError:
            pass
    data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
        if os.name == "posix":
            os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp_path, path)
    except BaseException:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def provider_requires_api_key(provider: LLMProviderConfig) -> bool:
    if provider.preset in {"ollama", "lmstudio"}:
        return False
    host = (urllib.parse.urlsplit(provider.base_url.strip()).hostname or "").lower()
    if host in {"127.0.0.1", "localhost", "::1"}:
        return False
    return True


def mask_secret(secret: str) -> str:
    value = secret.strip()
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


class SecretStore:
    """Stores provider API keys using Electron safeStorage when present, or 0600 local JSON."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._bridge_url = os.getenv("YOUDUB_SECRETS_BRIDGE_URL", "").strip().rstrip("/")
        self._bridge_token = os.getenv("YOUDUB_SECRETS_TOKEN", "").strip()

    def _read_raw(self) -> dict[str, dict[str, str]]:
        if not self.path.is_file():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _encrypt(self, plaintext: str) -> dict[str, str]:
        if self._bridge_url and self._bridge_token:
            try:
                response = httpx.post(
                    f"{self._bridge_url}/encrypt",
                    headers={"Authorization": f"Bearer {self._bridge_token}"},
                    json={"plaintext": plaintext},
                    timeout=3.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    if isinstance(data, dict) and isinstance(data.get("ciphertext"), str):
                        return {"scheme": "electron-safeStorage", "ciphertext": data["ciphertext"]}
            except httpx.HTTPError:
                pass
        return {"scheme": "local-file", "value": base64.b64encode(plaintext.encode("utf-8")).decode("ascii")}

    def _decrypt(self, entry: dict[str, str]) -> str:
        scheme = entry.get("scheme")
        if scheme == "electron-safeStorage":
            ciphertext = entry.get("ciphertext", "")
            if not ciphertext or not (self._bridge_url and self._bridge_token):
                return ""
            try:
                response = httpx.post(
                    f"{self._bridge_url}/decrypt",
                    headers={"Authorization": f"Bearer {self._bridge_token}"},
                    json={"ciphertext": ciphertext},
                    timeout=3.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    return data.get("plaintext", "") if isinstance(data, dict) else ""
            except httpx.HTTPError:
                return ""
        if scheme == "local-file":
            encoded = entry.get("value", "")
            if not encoded:
                return ""
            try:
                return base64.b64decode(encoded.encode("ascii")).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                return ""
        return ""

    def get(self, provider_id: str) -> str:
        entry = self._read_raw().get(provider_id)
        if not isinstance(entry, dict):
            return ""
        return self._decrypt(entry)

    def has(self, provider_id: str) -> bool:
        return bool(self.get(provider_id).strip())

    def set(self, provider_id: str, plaintext: str | None) -> None:
        raw = self._read_raw()
        if plaintext is None or not plaintext.strip():
            raw.pop(provider_id, None)
        else:
            raw[provider_id] = self._encrypt(plaintext.strip())
        _atomic_write_json(self.path, raw)

    def delete(self, provider_id: str) -> None:
        self.set(provider_id, None)


class SettingsStore:
    """Manages application settings, data directory lifecycle, and LLM provider configs."""

    def __init__(self, config_dir: Path | None = None) -> None:
        self.config_dir = (config_dir or default_config_dir()).expanduser().resolve()
        self.config_path = self.config_dir / "config.json"
        self.secrets = SecretStore(self.config_dir / "secrets.json")
        self._config = self._load()

    def _load(self) -> AppConfig:
        env_data_dir = os.getenv("YOUDUB_DATA_DIR", "").strip()
        if self.config_path.is_file():
            try:
                loaded = AppConfig.model_validate_json(self.config_path.read_text(encoding="utf-8"))
                if not loaded.llm_providers:
                    loaded.llm_providers = _default_providers()
                if env_data_dir and not loaded.data_dir:
                    loaded.data_dir = str(Path(env_data_dir).expanduser().resolve())
                return loaded
            except (OSError, ValueError):
                pass
        config = AppConfig(
            data_dir=str(Path(env_data_dir).expanduser().resolve()) if env_data_dir else None,
            llm_providers=_default_providers(),
        )
        return config

    def save(self) -> None:
        _atomic_write_json(self.config_path, self._config.model_dump())

    @property
    def config(self) -> AppConfig:
        return self._config

    def data_path(self) -> Path | None:
        if not self._config.data_dir:
            return None
        return Path(self._config.data_dir).expanduser().resolve()

    def configure_data_dir(self, raw_path: str) -> Path:
        candidate_str = raw_path.strip()
        if not candidate_str:
            raise AppError(422, "INVALID_DIRECTORY", "Data directory path is required.")
        candidate = Path(candidate_str).expanduser().resolve()
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            for sub in ("models", "runtime", "tasks", "uploads"):
                (candidate / sub).mkdir(parents=True, exist_ok=True)
            probe = candidate / ".youdub-write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
        except OSError as exc:
            raise AppError(
                422,
                "DIRECTORY_NOT_WRITABLE",
                f"Cannot write to directory: {candidate} ({exc})",
            ) from exc
        self._config.data_dir = str(candidate)
        self.save()
        return candidate

    YOUTUBE_COOKIES_SECRET_KEY = "youtube_cookies"

    @staticmethod
    def _normalize_netscape_cookies(raw: str) -> str:
        text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            return ""
        valid_lines = 0
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#") and not stripped.startswith("#HttpOnly_"):
                continue
            if stripped.count("\t") < 6:
                raise AppError(
                    422,
                    "INVALID_COOKIES",
                    "Expected Netscape HTTP Cookie File format (7 tab-separated columns per cookie line).",
                )
            valid_lines += 1
        if valid_lines == 0:
            raise AppError(
                422,
                "INVALID_COOKIES",
                "No cookie entries found in Netscape HTTP Cookie File.",
            )
        return text + "\n"

    def update_general(
        self,
        *,
        ui_language: UiLanguage | None = None,
        theme: ThemeMode | None = None,
        data_dir: str | None = None,
        proxy_url: str | None = None,
        youtube_cookies: str | None = None,
        clear_youtube_cookies: bool = False,
    ) -> AppConfig:
        if ui_language is not None:
            self._config.ui_language = ui_language
        if theme is not None:
            self._config.theme = theme
        if proxy_url is not None:
            self._config.proxy_url = proxy_url.strip()
        if clear_youtube_cookies:
            self.secrets.delete(self.YOUTUBE_COOKIES_SECRET_KEY)
        elif youtube_cookies is not None:
            normalized = self._normalize_netscape_cookies(youtube_cookies)
            if normalized:
                self.secrets.set(self.YOUTUBE_COOKIES_SECRET_KEY, normalized)
            else:
                self.secrets.delete(self.YOUTUBE_COOKIES_SECRET_KEY)
        if data_dir is not None:
            self.configure_data_dir(data_dir)
        else:
            self.save()
        return self._config

    def get_provider(self, provider_id: str) -> LLMProviderConfig | None:
        return next((item for item in self._config.llm_providers if item.id == provider_id), None)

    def upsert_provider(
        self,
        provider: LLMProviderConfig,
        *,
        api_key: str | None = None,
        clear_api_key: bool = False,
    ) -> LLMProviderConfig:
        existing = self.get_provider(provider.id)
        if existing is None:
            self._config.llm_providers.append(provider)
        else:
            idx = self._config.llm_providers.index(existing)
            self._config.llm_providers[idx] = provider
        if clear_api_key:
            self.secrets.delete(provider.id)
        elif api_key is not None and api_key.strip():
            self.secrets.set(provider.id, api_key)
        self.save()
        return provider

    def delete_provider(self, provider_id: str) -> None:
        before = len(self._config.llm_providers)
        self._config.llm_providers = [p for p in self._config.llm_providers if p.id != provider_id]
        if len(self._config.llm_providers) == before:
            raise AppError(404, "PROVIDER_NOT_FOUND", f"LLM provider {provider_id!r} does not exist.")
        self.secrets.delete(provider_id)
        self.save()

    def provider_view(self, provider: LLMProviderConfig) -> dict[str, object]:
        secret = self.secrets.get(provider.id)
        requires_key = provider_requires_api_key(provider)
        configured = bool(
            provider.enabled
            and provider.base_url.strip()
            and provider.default_model.strip()
            and (bool(secret) or not requires_key)
        )
        return {
            **provider.model_dump(),
            "requiresApiKey": requires_key,
            "hasApiKey": bool(secret),
            "apiKeyHint": mask_secret(secret),
            "available": configured,
            "unavailableReason": None if configured else "Provider connection is not configured.",
        }

    def settings_view(self) -> dict[str, object]:
        return {
            "ui_language": self._config.ui_language,
            "theme": self._config.theme,
            "data_dir": self._config.data_dir,
            "default_data_dir": str(default_data_dir()),
            "proxy_url": self._config.proxy_url,
            "has_youtube_cookies": self.secrets.has(self.YOUTUBE_COOKIES_SECRET_KEY),
            "llm_providers": [self.provider_view(p) for p in self._config.llm_providers],
        }
