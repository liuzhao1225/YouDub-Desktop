"""Multi-protocol LLM client (OpenAI, Anthropic, Gemini) and #196 structured subtitle translation."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import urllib.parse
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from .errors import AppError
from .settings import LLMProviderConfig, provider_requires_api_key

PRESETS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek",
        "protocol": "openai",
        "base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "requires_api_key": True,
    },
    "openai": {
        "id": "openai",
        "name": "OpenAI",
        "protocol": "openai",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
        "requires_api_key": True,
    },
    "anthropic": {
        "id": "anthropic",
        "name": "Anthropic Claude",
        "protocol": "anthropic",
        "base_url": "https://api.anthropic.com",
        "default_model": "claude-sonnet-4-20250514",
        "models": ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest"],
        "requires_api_key": True,
    },
    "gemini": {
        "id": "gemini",
        "name": "Google Gemini",
        "protocol": "gemini",
        "base_url": "https://generativelanguage.googleapis.com",
        "default_model": "gemini-2.5-flash",
        "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
        "requires_api_key": True,
    },
    "openrouter": {
        "id": "openrouter",
        "name": "OpenRouter",
        "protocol": "openai",
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "openai/gpt-4o-mini",
        "models": ["openai/gpt-4o-mini", "deepseek/deepseek-chat-v3-0324"],
        "requires_api_key": True,
    },
    "openllm": {
        "id": "openllm",
        "name": "OpenLLM",
        "protocol": "openai",
        "base_url": "https://www.openllm.sh/v1",
        "default_model": "plus",
        "models": ["lite", "plus", "ultra"],
        "requires_api_key": True,
    },
    "siliconflow": {
        "id": "siliconflow",
        "name": "SiliconFlow",
        "protocol": "openai",
        "base_url": "https://api.siliconflow.cn/v1",
        "default_model": "deepseek-ai/DeepSeek-V3",
        "models": ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
        "requires_api_key": True,
    },
    "dashscope": {
        "id": "dashscope",
        "name": "DashScope",
        "protocol": "openai",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "default_model": "qwen-plus",
        "models": ["qwen-plus", "qwen-max", "qwen-turbo"],
        "requires_api_key": True,
    },
    "zhipu": {
        "id": "zhipu",
        "name": "Zhipu",
        "protocol": "openai",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "glm-4-plus",
        "models": ["glm-4-plus", "glm-4-air"],
        "requires_api_key": True,
    },
    "moonshot": {
        "id": "moonshot",
        "name": "Moonshot",
        "protocol": "openai",
        "base_url": "https://api.moonshot.cn/v1",
        "default_model": "moonshot-v1-8k",
        "models": ["moonshot-v1-8k", "moonshot-v1-32k"],
        "requires_api_key": True,
    },
    "ollama": {
        "id": "ollama",
        "name": "Ollama (Local)",
        "protocol": "openai",
        "base_url": "http://127.0.0.1:11434/v1",
        "default_model": "qwen2.5:14b",
        "models": [],
        "requires_api_key": False,
    },
    "lmstudio": {
        "id": "lmstudio",
        "name": "LM Studio",
        "protocol": "openai",
        "base_url": "http://127.0.0.1:1234/v1",
        "default_model": "",
        "models": [],
        "requires_api_key": False,
    },
    "custom": {
        "id": "custom",
        "name": "Custom",
        "protocol": "openai",
        "base_url": "",
        "default_model": "",
        "models": [],
        "requires_api_key": True,
    },
}

CHINESE_SUBTITLE_PUNCTUATION_RULES = """\
使用中文标点（，。！？；：“”『』（）；破折号(——)被**禁止**，改用括号或逗号分句；省略号用…）。
冒号后如接列表或解释，按中文习惯断句；引号统一用“”，保持全文风格一致。
对于长句，使用逗号进行更详细的分句。
必须使用标点。"""

LANGUAGE_NAMES = {
    "zh": "Simplified Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "auto": "Auto-detected language",
}


def _is_loopback_url(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def _build_client(
    base_url: str,
    *,
    proxy_url: str = "",
    timeout: float = 60.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    effective_proxy = None if (not proxy_url.strip() or _is_loopback_url(base_url)) else proxy_url.strip()
    return httpx.AsyncClient(
        proxy=effective_proxy,
        timeout=httpx.Timeout(timeout),
        trust_env=False,
        transport=transport,
    )


def _normalize_openai_base(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    for suffix in ("/chat/completions", "/models"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return base


def _normalize_anthropic_base(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    for suffix in ("/v1/messages", "/v1/models", "/messages"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    if base.endswith("/v1"):
        base = base[:-3]
    return base


def _normalize_gemini_base(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1beta"):
        base = base[:-7]
    return base


def _extract_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            err = payload.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            if isinstance(err, str) and err:
                return err
            if payload.get("message"):
                return str(payload["message"])
    except ValueError:
        pass
    text = response.text.strip()
    return text[:400] or f"HTTP {response.status_code}"


def _extract_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fenced = re.match(r"^```(?:json)?\s*\n?(.*?)\n?```$", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    try:
        parsed = json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"Expected JSON object in model output: {raw[:200]}")
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Expected top-level JSON object from model.")
    return parsed


async def complete_chat(
    provider: LLMProviderConfig,
    api_key: str,
    *,
    system: str,
    messages: list[dict[str, str]],
    model: str | None = None,
    json_mode: bool = False,
    max_tokens: int | None = None,
    proxy_url: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Execute one chat completion across OpenAI, Anthropic, or Gemini protocols."""
    chosen_model = (model or provider.default_model).strip()
    if not provider.base_url.strip() or not chosen_model:
        raise AppError(422, "PROVIDER_NOT_CONFIGURED", "LLM base URL and model must be configured.")
    requires_key = provider_requires_api_key(provider)
    if requires_key and not api_key.strip():
        raise AppError(422, "PROVIDER_NOT_CONFIGURED", f"API key is missing for provider {provider.name}.")

    async with _build_client(provider.base_url, proxy_url=proxy_url, transport=transport) as client:
        if provider.protocol == "openai":
            base = _normalize_openai_base(provider.base_url)
            headers = {"Content-Type": "application/json"}
            if api_key.strip():
                headers["Authorization"] = f"Bearer {api_key.strip()}"
            openai_messages = [{"role": "system", "content": system}, *messages] if system else list(messages)
            body: dict[str, Any] = {
                "model": chosen_model,
                "messages": openai_messages,
                "temperature": 0.2,
            }
            if max_tokens:
                body["max_tokens"] = max_tokens
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            response = await client.post(f"{base}/chat/completions", headers=headers, json=body)
            if response.status_code == 400 and json_mode:
                body.pop("response_format", None)
                response = await client.post(f"{base}/chat/completions", headers=headers, json=body)
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            try:
                content = data["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as exc:
                raise AppError(502, "INVALID_PROVIDER_RESULT", "OpenAI-compatible response lacked message content.") from exc
            return str(content)

        if provider.protocol == "anthropic":
            base = _normalize_anthropic_base(provider.base_url)
            headers = {
                "Content-Type": "application/json",
                "x-api-key": api_key.strip(),
                "anthropic-version": "2023-06-01",
            }
            body = {
                "model": chosen_model,
                "max_tokens": max_tokens or 2048,
                "messages": messages,
            }
            if system:
                body["system"] = system
            response = await client.post(f"{base}/v1/messages", headers=headers, json=body)
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            blocks = data.get("content")
            if not isinstance(blocks, list) or not blocks:
                raise AppError(502, "INVALID_PROVIDER_RESULT", "Anthropic response contained no content blocks.")
            text_parts = [str(block.get("text", "")) for block in blocks if isinstance(block, dict) and block.get("type") == "text"]
            return "".join(text_parts)

        if provider.protocol == "gemini":
            base = _normalize_gemini_base(provider.base_url)
            headers = {
                "Content-Type": "application/json",
                "x-goog-api-key": api_key.strip(),
            }
            contents = [
                {
                    "role": "model" if msg["role"] == "assistant" else "user",
                    "parts": [{"text": msg["content"]}],
                }
                for msg in messages
            ]
            generation_config: dict[str, Any] = {"temperature": 0.2}
            if max_tokens:
                generation_config["maxOutputTokens"] = max_tokens
            if json_mode:
                generation_config["responseMimeType"] = "application/json"
            body = {"contents": contents, "generationConfig": generation_config}
            if system:
                body["systemInstruction"] = {"parts": [{"text": system}]}
            model_path = chosen_model.removeprefix("models/")
            response = await client.post(
                f"{base}/v1beta/models/{model_path}:generateContent",
                headers=headers,
                json=body,
            )
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            try:
                parts = data["candidates"][0]["content"]["parts"]
                return "".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
            except (KeyError, IndexError, TypeError) as exc:
                raise AppError(502, "INVALID_PROVIDER_RESULT", "Gemini response contained no candidate text.") from exc

    raise AppError(422, "UNSUPPORTED_PROTOCOL", f"Unsupported protocol: {provider.protocol}")


async def discover_models(
    provider: LLMProviderConfig,
    api_key: str,
    *,
    proxy_url: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[str]:
    """Query the provider's model list endpoint using its native protocol."""
    if not provider.base_url.strip():
        raise AppError(422, "PROVIDER_NOT_CONFIGURED", "Base URL is required before fetching models.")
    async with _build_client(provider.base_url, proxy_url=proxy_url, timeout=20.0, transport=transport) as client:
        if provider.protocol == "openai":
            base = _normalize_openai_base(provider.base_url)
            headers = {"Authorization": f"Bearer {api_key.strip()}"} if api_key.strip() else {}
            response = await client.get(f"{base}/models", headers=headers)
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else []
            return sorted({str(item["id"]) for item in items if isinstance(item, dict) and item.get("id")})

        if provider.protocol == "anthropic":
            base = _normalize_anthropic_base(provider.base_url)
            headers = {
                "x-api-key": api_key.strip(),
                "anthropic-version": "2023-06-01",
            }
            response = await client.get(f"{base}/v1/models", headers=headers)
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else []
            return sorted({str(item["id"]) for item in items if isinstance(item, dict) and item.get("id")})

        if provider.protocol == "gemini":
            base = _normalize_gemini_base(provider.base_url)
            headers = {"x-goog-api-key": api_key.strip()}
            response = await client.get(f"{base}/v1beta/models", headers=headers)
            if response.status_code >= 400:
                raise AppError(502, "LLM_REQUEST_FAILED", _extract_error_message(response))
            data = response.json()
            items = data.get("models") if isinstance(data, dict) else []
            return sorted(
                {str(item["name"]).removeprefix("models/") for item in items if isinstance(item, dict) and item.get("name")}
            )

    raise AppError(422, "UNSUPPORTED_PROTOCOL", f"Unsupported protocol: {provider.protocol}")


async def probe_connection(
    provider: LLMProviderConfig,
    api_key: str,
    *,
    proxy_url: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Run a tiny completion probe to verify endpoint, key, and selected model."""
    started = time.monotonic()
    reply = await complete_chat(
        provider,
        api_key,
        system="You are a connectivity check. Reply briefly.",
        messages=[{"role": "user", "content": "Reply with OK."}],
        max_tokens=16,
        proxy_url=proxy_url,
        transport=transport,
    )
    latency_ms = round((time.monotonic() - started) * 1000)
    return {
        "ok": True,
        "latencyMs": latency_ms,
        "model": provider.default_model,
        "message": reply.strip()[:120] or "OK",
    }


def _translation_system_prompt(source_language: str, target_language: str, source_texts: list[str]) -> str:
    src_name = LANGUAGE_NAMES.get(source_language, source_language)
    tgt_name = LANGUAGE_NAMES.get(target_language, target_language)
    transcript_json = json.dumps(source_texts, ensure_ascii=False)
    lines = [
        f"You are an expert video subtitle translator. Translate spoken lines from {src_name} ({source_language}) into {tgt_name} ({target_language}).",
        "Complete full source transcript for context:",
        transcript_json,
        "",
        "Task rules:",
        f"- In each turn, the user gives one line formatted as JSON {{\"{source_language}\": \"...\"}}.",
        f"- Return ONLY a single valid JSON object formatted as {{\"{target_language}\": \"...\"}}.",
        "- Preserve natural conversational tone, proper nouns, numbers, and terminology consistently across the video.",
        "- Never omit or summarize content, and never output explanations or markdown.",
    ]
    if target_language.split("-", 1)[0].lower() == "zh":
        lines.extend(["", "Chinese punctuation rules:", CHINESE_SUBTITLE_PUNCTUATION_RULES])
    return "\n".join(lines)


async def translate_transcript(
    transcript: dict[str, Any],
    *,
    source_language: str,
    target_language: str,
    provider: LLMProviderConfig,
    api_key: str,
    checkpoint_root: Path,
    model: str | None = None,
    max_completion_tokens: int | None = None,
    proxy_url: str = "",
    on_progress: Callable[[float | None, str], None] | None = None,
    on_log: Callable[[str], None] | None = None,
    check_cancel: Callable[[], None] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Translate a transcript one sentence at a time with rolling context & checkpoints (#196)."""
    segments = transcript.get("segments")
    if not isinstance(segments, list) or not segments:
        raise AppError(422, "INVALID_TRANSCRIPT", "Transcript contains no segments to translate.")
    effective_source = transcript.get("detected_language") or source_language
    if effective_source == "auto":
        effective_source = "en"
    chosen_model = (model or provider.default_model).strip()
    source_texts = [str(seg["text"]) for seg in segments]

    digest_input = json.dumps(
        {
            "provider": provider.id,
            "model": chosen_model,
            "source": effective_source,
            "target": target_language,
            "segments": [{"id": seg["id"], "text": seg["text"]} for seg in segments],
        },
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    run_hash = hashlib.sha256(digest_input).hexdigest()[:24]
    checkpoint_dir = checkpoint_root / "translation-progress" / run_hash
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    system_prompt = _translation_system_prompt(effective_source, target_language, source_texts)
    history: list[dict[str, str]] = []
    translated_segments: list[dict[str, str]] = []
    total = len(segments)
    max_history_messages = 60  # 30 prior sentence pairs kept in rolling context window

    for index, segment in enumerate(segments, start=1):
        if check_cancel is not None:
            check_cancel()
        seg_id = str(segment["id"])
        src_text = str(segment["text"])
        user_payload = json.dumps({effective_source: src_text}, ensure_ascii=False)
        cp_file = checkpoint_dir / f"{index:06d}.json"

        translated_text: str | None = None
        if cp_file.is_file():
            try:
                cp = json.loads(cp_file.read_text(encoding="utf-8"))
                if cp.get("segment_id") == seg_id and isinstance(cp.get("text"), str) and cp["text"].strip():
                    translated_text = cp["text"]
            except (OSError, ValueError):
                translated_text = None

        if translated_text is None:
            last_error: Exception | None = None
            for attempt in range(1, 4):
                if check_cancel is not None:
                    check_cancel()
                try:
                    window = history[-max_history_messages:]
                    raw_reply = await complete_chat(
                        provider,
                        api_key,
                        system=system_prompt,
                        messages=[*window, {"role": "user", "content": user_payload}],
                        model=chosen_model,
                        json_mode=True,
                        max_tokens=max_completion_tokens,
                        proxy_url=proxy_url,
                        transport=transport,
                    )
                    parsed = _extract_json_object(raw_reply)
                    candidate = parsed.get(target_language)
                    if candidate is None and len(parsed) == 1:
                        candidate = next(iter(parsed.values()))
                    if not isinstance(candidate, str) or not candidate.strip():
                        raise ValueError(f"Missing translated string for {target_language!r}: {raw_reply[:200]}")
                    translated_text = candidate.strip()
                    break
                except Exception as exc:
                    last_error = exc
                    if attempt < 3:
                        await asyncio.sleep(0.25 * attempt)
            if translated_text is None:
                raise AppError(
                    502,
                    "TRANSLATION_FAILED",
                    f"Failed translating segment {seg_id} after 3 attempts: {last_error}",
                ) from last_error

            cp_tmp = checkpoint_dir / f".{index:06d}.tmp"
            cp_tmp.write_text(
                json.dumps({"segment_id": seg_id, "text": translated_text}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(cp_tmp, cp_file)

        history.append({"role": "user", "content": user_payload})
        history.append({"role": "assistant", "content": json.dumps({target_language: translated_text}, ensure_ascii=False)})
        translated_segments.append({"segment_id": seg_id, "text": translated_text})
        if on_progress is not None:
            on_progress(index / total, f"Translated {index}/{total}")
        if on_log is not None:
            on_log(f"[translate] ({index}/{total}) {seg_id}: {translated_text}")

    return {
        "source_language": effective_source,
        "target_language": target_language,
        "segments": translated_segments,
    }
