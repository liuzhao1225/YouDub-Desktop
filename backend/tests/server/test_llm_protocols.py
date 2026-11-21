"""Tests for multi-protocol LLM clients (OpenAI, Anthropic, Gemini) and #196 translation."""

from __future__ import annotations

import json

import httpx
import pytest

from backend.app.server.llm import (
    PRESETS,
    CHINESE_SUBTITLE_PUNCTUATION_RULES,
    discover_models,
    probe_connection,
    translate_transcript,
)
from backend.app.server.settings import LLMProviderConfig


@pytest.mark.parametrize("protocol,url_part", [
    ("openai", "/chat/completions"),
    ("anthropic", "/v1/messages"),
    ("gemini", ":generateContent"),
])
@pytest.mark.anyio
async def test_test_connection_and_discover_models_all_protocols(protocol, url_part):
    seen_requests: list[tuple[str, str, dict, dict | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode()) if request.content else None
        seen_requests.append((request.method, str(request.url), dict(request.headers), body))
        if request.method == "GET":
            if protocol == "gemini":
                return httpx.Response(200, json={"models": [{"name": "models/gemini-2.5-flash"}]})
            return httpx.Response(200, json={"data": [{"id": "model-a"}, {"id": "model-b"}]})
        if protocol == "openai":
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
        if protocol == "anthropic":
            return httpx.Response(200, json={"content": [{"type": "text", "text": "OK"}]})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "OK"}]}}]})

    transport = httpx.MockTransport(handler)
    base_url = {
        "openai": "https://api.example.com/v1",
        "anthropic": "https://api.anthropic.com",
        "gemini": "https://generativelanguage.googleapis.com",
    }[protocol]
    provider = LLMProviderConfig(
        id="p1",
        name="Test",
        protocol=protocol,  # type: ignore[arg-type]
        preset=protocol,
        base_url=base_url,
        default_model="model-a",
    )
    models = await discover_models(provider, "secret-key", transport=transport)
    assert models == (["gemini-2.5-flash"] if protocol == "gemini" else ["model-a", "model-b"])

    probe = await probe_connection(provider, "secret-key", transport=transport)
    assert probe["ok"] is True
    assert url_part in seen_requests[-1][1]


@pytest.mark.anyio
async def test_translate_rolling_context_and_checkpoint_resume(tmp_path):
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        calls.append(payload)
        user_msg = json.loads(payload["messages"][-1]["content"])
        english = user_msg["en"]
        # Fail first request on segment 2 to prove checkpoint + resume skips segment 1
        if english == "Goodbye." and len(calls) == 2:
            return httpx.Response(502, json={"error": {"message": "Temporary gateway failure"}})
        mapping = {"Hello world.": "你好，世界。", "Goodbye.": "再见。"}
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps({"zh": mapping[english]}, ensure_ascii=False)}}]},
        )

    transport = httpx.MockTransport(handler)
    provider = LLMProviderConfig(
        id="openai",
        name="DeepSeek",
        protocol="openai",
        preset="deepseek",
        base_url="https://api.deepseek.com/v1",
        default_model="deepseek-chat",
    )
    transcript = {
        "detected_language": "en",
        "segments": [
            {"id": "segment-000001", "start_ms": 0, "end_ms": 1000, "text": "Hello world."},
            {"id": "segment-000002", "start_ms": 1200, "end_ms": 2200, "text": "Goodbye."},
        ],
    }

    result = await translate_transcript(
        transcript,
        source_language="en",
        target_language="zh",
        provider=provider,
        api_key="sk-test",
        checkpoint_root=tmp_path,
        transport=transport,
    )
    assert result == {
        "source_language": "en",
        "target_language": "zh",
        "segments": [
            {"segment_id": "segment-000001", "text": "你好，世界。"},
            {"segment_id": "segment-000002", "text": "再见。"},
        ],
    }
    # Verify full transcript context & Chinese punctuation rules were injected in system prompt
    system_msg = calls[0]["messages"][0]["content"]
    assert "Hello world." in system_msg and "Goodbye." in system_msg
    assert CHINESE_SUBTITLE_PUNCTUATION_RULES.splitlines()[0] in system_msg
    # Verify 2nd call carried rolling context from turn 1
    assert len(calls[-1]["messages"]) == 4  # system + user1 + assistant1 + user2

    # Second call with same checkpoint_root reuses checkpoints with ZERO HTTP requests!
    before_count = len(calls)
    resumed = await translate_transcript(
        transcript,
        source_language="en",
        target_language="zh",
        provider=provider,
        api_key="sk-test",
        checkpoint_root=tmp_path,
        transport=transport,
    )
    assert resumed == result
    assert len(calls) == before_count


@pytest.mark.anyio
async def test_openllm_preset_uses_openai_chat_completions():
    preset = PRESETS["openllm"]
    assert preset["protocol"] == "openai"
    assert preset["base_url"] == "https://www.openllm.sh/v1"
    assert preset["default_model"] == "plus"
    assert preset["models"] == ["lite", "plus", "ultra"]
    assert preset["requires_api_key"] is True

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

    provider = LLMProviderConfig(
        id="openllm",
        name=preset["name"],
        protocol="openai",
        preset="openllm",
        base_url=preset["base_url"],
        default_model=preset["default_model"],
    )
    result = await probe_connection(provider, "sk-llm-test", transport=httpx.MockTransport(handler))
    assert result["ok"] is True
    assert str(seen[-1].url) == "https://www.openllm.sh/v1/chat/completions"
    assert seen[-1].headers["authorization"] == "Bearer sk-llm-test"
    assert json.loads(seen[-1].content)["model"] == "plus"
