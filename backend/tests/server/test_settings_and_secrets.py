"""Tests for application settings and OS-backed / 0600 secret storage."""

from __future__ import annotations

import base64
import json
import os
import stat
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

from backend.app.server.errors import AppError
from backend.app.server.settings import LLMProviderConfig, SettingsStore, mask_secret


def test_settings_defaults_and_file_permissions(tmp_path):
    store = SettingsStore(config_dir=tmp_path / "cfg")
    view = store.settings_view()
    assert view["ui_language"] == "zh"
    assert view["theme"] == "system"
    assert view["data_dir"] is None
    assert len(view["llm_providers"]) == 1
    assert view["llm_providers"][0]["id"] == "openai"

    data_dir = store.configure_data_dir(str(tmp_path / "workspace"))
    assert data_dir.is_dir()
    for sub in ("models", "runtime", "tasks", "uploads"):
        assert (data_dir / sub).is_dir()

    store.upsert_provider(
        LLMProviderConfig(
            id="openai",
            name="DeepSeek",
            protocol="openai",
            preset="deepseek",
            base_url="https://api.deepseek.com/v1",
            default_model="deepseek-chat",
        ),
        api_key="sk-secret-value-12345678",
    )
    pv = store.provider_view(store.get_provider("openai"))  # type: ignore[arg-type]
    assert pv["hasApiKey"] is True
    assert pv["apiKeyHint"] == "sk-s...5678"
    assert pv["available"] is True
    assert "sk-secret-value-12345678" not in json.dumps(pv)

    if os.name == "posix":
        assert stat.S_IMODE(store.config_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(store.secrets.path.stat().st_mode) == 0o600


def test_electron_safestorage_bridge_encrypt_decrypt(monkeypatch, tmp_path):
    calls: list[str] = []

    class BridgeHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            calls.append(self.path)
            if self.headers.get("Authorization") != "Bearer bridge-tok":
                self.send_response(401)
                self.end_headers()
                return
            if self.path == "/encrypt":
                cipher = base64.b64encode(("ENC:" + body["plaintext"]).encode()).decode()
                payload = json.dumps({"ciphertext": cipher}).encode()
            elif self.path == "/decrypt":
                raw = base64.b64decode(body["ciphertext"]).decode()
                assert raw.startswith("ENC:")
                payload = json.dumps({"plaintext": raw[4:]}).encode()
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), BridgeHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("YOUDUB_SECRETS_BRIDGE_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("YOUDUB_SECRETS_TOKEN", "bridge-tok")
        store = SettingsStore(config_dir=tmp_path / "cfg")
        store.secrets.set("anthropic-1", "sk-ant-my-super-key")
        saved = json.loads(store.secrets.path.read_text())
        assert saved["anthropic-1"]["scheme"] == "electron-safeStorage"
        assert "sk-ant-my-super-key" not in store.secrets.path.read_text()
        assert store.secrets.get("anthropic-1") == "sk-ant-my-super-key"
        assert calls == ["/encrypt", "/decrypt"]
    finally:
        server.shutdown()


def test_mask_secret_handles_short_values():
    assert mask_secret("") == ""
    assert mask_secret("short") == "*****"
    assert mask_secret("sk-1234567890") == "sk-1...7890"


def test_unwritable_data_dir_raises(tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("file")
    store = SettingsStore(config_dir=tmp_path / "cfg")
    with pytest.raises(AppError) as exc:
        store.configure_data_dir(str(blocker / "child"))
    assert exc.value.code == "DIRECTORY_NOT_WRITABLE"


def test_local_lmstudio_and_loopback_providers_do_not_require_api_key_and_active_task_blocks_data_dir_switch(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend.app.server.api import create_app

    store = SettingsStore(config_dir=tmp_path / "cfg")
    lmstudio = store.upsert_provider(
        LLMProviderConfig(
            id="lmstudio",
            name="LM Studio",
            protocol="openai",
            preset="lmstudio",
            base_url="http://127.0.0.1:1234/v1",
            default_model="qwen2.5-7b-instruct",
            enabled=True,
        )
    )
    pv = store.provider_view(lmstudio)
    assert pv["requiresApiKey"] is False
    assert pv["available"] is True

    app = create_app(config_dir=tmp_path / "cfg2")
    with TestClient(app) as client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "ws1")})
        presets = {p["id"] for p in client.get("/api/llm/presets").json()["items"]}
        assert {"lmstudio", "dashscope", "zhipu", "moonshot", "ollama"} <= presets

        monkeypatch.setattr(app.state.runner, "has_active_runs", lambda: True)
        blocked = client.patch("/api/settings", json={"data_dir": str(tmp_path / "ws2")})
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "TASK_ACTIVE"


def test_youtube_cookies_stored_securely_and_never_exposed_in_settings_view(tmp_path: Path) -> None:
    import json
    from fastapi.testclient import TestClient
    from backend.app.server.api import create_app

    cfg_dir = tmp_path / "cfg"
    app = create_app(config_dir=cfg_dir)
    sample_cookies = (
        "# Netscape HTTP Cookie File\n"
        ".youtube.com\tTRUE\t/\tTRUE\t1828172299\tLOGIN_INFO\tdummy-secret-cookie-value\n"
    )
    with TestClient(app) as client:
        initial = client.get("/api/settings").json()
        assert initial["has_youtube_cookies"] is False

        invalid = client.patch("/api/settings", json={"youtube_cookies": "not-netscape-cookies"})
        assert invalid.status_code == 422
        assert invalid.json()["error"]["code"] == "INVALID_COOKIES"

        saved = client.patch("/api/settings", json={"youtube_cookies": sample_cookies})
        assert saved.status_code == 200
        assert saved.json()["has_youtube_cookies"] is True

        view = client.get("/api/settings").json()
        assert view["has_youtube_cookies"] is True
        assert "dummy-secret-cookie-value" not in json.dumps(view)
        assert "dummy-secret-cookie-value" not in (cfg_dir / "config.json").read_text(encoding="utf-8")
        assert app.state.settings.secrets.get("youtube_cookies") == sample_cookies.strip()

        cleared = client.patch("/api/settings", json={"clear_youtube_cookies": True})
        assert cleared.status_code == 200
        assert cleared.json()["has_youtube_cookies"] is False
        assert app.state.settings.secrets.get("youtube_cookies") == ""
