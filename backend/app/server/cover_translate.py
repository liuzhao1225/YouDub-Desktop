"""Translate video covers using Volcengine Ark image-editing models."""

from __future__ import annotations

import asyncio
import base64
import os
import tempfile
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageOps

from .errors import AppError
from .llm import _build_client, _extract_error_message
from .settings import ImageProviderConfig, provider_requires_api_key

MAX_SOURCE_IMAGE_DIM = 2048
MAX_DOWNLOAD_IMAGE_BYTES = 32 * 1024 * 1024
_RETRYABLE_GEN_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.HTTPStatusError)


def normalize_ark_image_endpoint(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    return base if base.endswith("/images/generations") else base + "/images/generations"


@dataclass(frozen=True)
class SeedreamProfile:
    name: str
    image_as_list: bool
    size: str
    include_sequential_disabled: bool


def resolve_seedream_profile(model: str) -> SeedreamProfile:
    m = model.strip().lower()
    if "seededit-3-0" in m or "seededit-3.0" in m:
        return SeedreamProfile("seededit-3.0", False, "adaptive", False)
    legacy = (
        "seedream-4-0", "seedream-4.0", "seedream-4-5", "seedream-4.5",
        "seedream-5-0-lite", "seedream-5.0-lite",
    )
    if any(token in m for token in legacy) or (
        ("seedream-5-0" in m or "seedream-5.0" in m) and "pro" not in m and "flash" not in m
    ):
        return SeedreamProfile("seedream-4.x", True, "2K", True)
    return SeedreamProfile("seedream-5.5", True, "2K", False)


def build_seedream_payload(
    *, model: str, prompt: str, image_base64: str, watermark: bool = False
) -> tuple[dict[str, Any], SeedreamProfile]:
    profile = resolve_seedream_profile(model)
    data_url = f"data:image/jpeg;base64,{image_base64}"
    payload = {
        "model": model,
        "prompt": prompt,
        "image": [data_url] if profile.image_as_list else data_url,
        "response_format": "url",
        "size": profile.size,
        "watermark": bool(watermark),
    }
    if profile.include_sequential_disabled:
        payload["sequential_image_generation"] = "disabled"
    return payload, profile


def build_cover_prompt(
    *, target_language: str, cover_title: str = "", context_excerpt: str = "",
    custom_prompt: str = "", aspect_ratio: str = "16:9",
) -> str:
    title = cover_title.strip()
    wide = aspect_ratio in {"16:9", "4:3_padded"}
    if target_language == "zh":
        intro = (
            "这是一个视频封面。先理解图片。保持原图风格，富有设计感，确保文字清晰可见，正确排版，富有视觉冲击力，不遮挡视觉主体，自然融入。"
            "标题最重要的是醒目和吸引人，要能够增加视频点击率，因此尽量使用亮色，不要使用渐变色。"
        )
        ratio = "宽高比 16:9。" if wide else "保持原图宽高比。"
        edit = (
            f'将封面原有标题替换为中文标题：“{title}”。保持原有字体风格、颜色、位置和排版，移除被替换的原文。若原图没有标题，则自然融入该标题。'
            if title else "将封面中的所有文字自然地翻译成简体中文，保持原有字体风格、颜色、位置和排版，彻底移除被替换的原文字符。"
        )
        context_label = "视频上下文（仅供理解，不要印在封面上）"
    elif target_language == "en":
        intro = "Keep the cover’s composition and visual style. Keep the subject visible and the text legible."
        ratio = "Use a 16:9 aspect ratio." if wide else "Keep the original aspect ratio."
        edit = (
            f'Replace the existing title with "{title}", removing the old lettering. If there is no title, integrate it naturally.'
            if title else "Translate all visible text into natural English and remove all source-language lettering."
        ) + " Match the original typography, color, position and layout."
        context_label = "Video context (for reference only, never print on the cover)"
    elif target_language == "ja":
        intro = "動画サムネイルの構図と画風を保ち、主役を隠さず、文字を読みやすくしてください。"
        ratio = "縦横比は横16対縦9（16:9）にしてください。" if wide else "元画像の縦横比を保ってください。"
        edit = (
            f"元のタイトルを「{title}」に差し替え、元の文字を消してください。タイトルがない場合は自然に配置してください。"
            if title else "画像内のすべての文字を自然な日本語に翻訳し、元の言語の文字を完全に消してください。"
        ) + "元の書体、色、位置、レイアウトを保ってください。"
        context_label = "動画の参考情報（画像には記載しないでください）"
    else:
        raise AppError(422, "INVALID_CONFIG", f"Unsupported cover language: {target_language}")
    parts = [intro + ratio if target_language == "zh" else f"{intro} {ratio}", edit]
    if not title and context_excerpt.strip():
        parts.append(f"{context_label}: {context_excerpt.strip()[:400]}")
    if custom_prompt.strip():
        parts.append(custom_prompt.strip())
    return "\n".join(parts)


def _jpeg_base64(image: Image.Image) -> str:
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=95)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def encode_source_cover_jpeg(image_path: Path) -> tuple[tuple[int, int], str]:
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    original_size = image.size
    if max(original_size) > MAX_SOURCE_IMAGE_DIM:
        image.thumbnail((MAX_SOURCE_IMAGE_DIM, MAX_SOURCE_IMAGE_DIM), Image.Resampling.LANCZOS)
    return original_size, _jpeg_base64(image)


def _validate_aspect_ratio(aspect_ratio: str) -> None:
    if aspect_ratio not in {"16:9", "4:3_padded", "original"}:
        raise AppError(422, "INVALID_CONFIG", f"Unsupported cover aspect ratio: {aspect_ratio}")


def postprocess_cover_image(
    image_bytes: bytes, output_path: Path, *, aspect_ratio: str, original_size: tuple[int, int]
) -> tuple[int, int]:
    _validate_aspect_ratio(aspect_ratio)
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            image = source.convert("RGB")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise AppError(502, "INVALID_PROVIDER_RESULT", f"Invalid image from provider: {exc}") from exc

    size = original_size if aspect_ratio == "original" else (1280, 720)
    if image.size != size:
        image = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    if aspect_ratio == "4:3_padded":
        image = ImageOps.expand(image, border=(0, 120, 0, 120), fill=(0, 0, 0))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(dir=output_path.parent, delete=False)
    tmp_path = Path(tmp.name)
    try:
        with tmp:
            image.save(tmp, format="JPEG", quality=95)
        os.replace(tmp_path, output_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    with Image.open(output_path) as saved:
        saved.verify()
    return image.size


def _provider_headers(provider: ImageProviderConfig, model: str, api_key: str) -> dict[str, str]:
    if not provider.base_url.strip() or not model:
        raise AppError(422, "PROVIDER_NOT_CONFIGURED", "Image provider base URL and model must be configured.")
    if provider_requires_api_key(provider) and not api_key.strip():
        raise AppError(422, "PROVIDER_NOT_CONFIGURED", f"API key is missing for provider {provider.name}.")
    return {"Authorization": f"Bearer {api_key.strip()}"} if api_key.strip() else {}


def _check_response(response: httpx.Response) -> None:
    status = response.status_code
    if status == 429 or status >= 500:
        response.raise_for_status()
    if status >= 400:
        code = "IMAGE_AUTH_ERROR" if status in {401, 403} else "COVER_TRANSLATE_FAILED"
        raise AppError(502, code, _extract_error_message(response))


def _check_download_response(response: httpx.Response) -> None:
    status = response.status_code
    if status == 429 or status >= 500:
        response.raise_for_status()
    if status >= 400:
        raise AppError(502, "COVER_TRANSLATE_FAILED", _extract_error_message(response))


def _request_error(exc: httpx.TransportError | httpx.HTTPStatusError) -> AppError:
    message = _extract_error_message(exc.response) if isinstance(exc, httpx.HTTPStatusError) else str(exc)
    return AppError(502, "COVER_TRANSLATE_FAILED", message)


async def _generate(
    client: httpx.AsyncClient, endpoint: str, headers: dict[str, str], payload: dict[str, Any],
) -> tuple[str, str]:
    response = await client.post(endpoint, headers=headers, json=payload)
    _check_response(response)
    try:
        items = response.json()["data"]
        if isinstance(items, list) and items and isinstance(items[0], dict):
            for field in ("b64_json", "url"):
                value = items[0].get(field)
                if isinstance(value, str) and value.strip():
                    cleaned = value.strip()
                    if field == "url" and urllib.parse.urlsplit(cleaned).scheme.lower() not in {"http", "https"}:
                        raise AppError(502, "INVALID_PROVIDER_RESULT", "Generated image URL must use http or https.")
                    return field, cleaned
    except AppError:
        raise
    except (ValueError, KeyError, TypeError) as exc:
        raise AppError(502, "INVALID_PROVIDER_RESULT", "Invalid image generation response.") from exc
    raise AppError(502, "INVALID_PROVIDER_RESULT", "Image generation response lacked a URL or base64 image.")


async def _download_generated_image(
    image_url: str, *, proxy_url: str = "", transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    if urllib.parse.urlsplit(image_url).scheme.lower() not in {"http", "https"}:
        raise AppError(502, "INVALID_PROVIDER_RESULT", "Generated image URL must use http or https.")
    async with _build_client(image_url, proxy_url=proxy_url, timeout=60.0, transport=transport) as dl_client:
        async with dl_client.stream("GET", image_url, timeout=60.0, follow_redirects=True) as response:
            if response.status_code >= 400:
                await response.aread()
                _check_download_response(response)
            raw_length = response.headers.get("content-length")
            if raw_length is not None:
                try:
                    if int(raw_length) > MAX_DOWNLOAD_IMAGE_BYTES:
                        raise AppError(502, "INVALID_PROVIDER_RESULT", "Downloaded cover image exceeds maximum allowed size.")
                except ValueError:
                    pass
            chunks = bytearray()
            async for chunk in response.aiter_bytes():
                chunks.extend(chunk)
                if len(chunks) > MAX_DOWNLOAD_IMAGE_BYTES:
                    raise AppError(502, "INVALID_PROVIDER_RESULT", "Downloaded cover image exceeds maximum allowed size.")
            return bytes(chunks)


async def translate_cover(
    source_image_path: Path, output_path: Path, *, provider: ImageProviderConfig, api_key: str,
    model: str | None = None, target_language: str = "zh", cover_title: str = "",
    context_excerpt: str = "", custom_prompt: str = "", aspect_ratio: str = "16:9",
    watermark: bool = False, proxy_url: str = "",
    on_progress: Callable[[float | None, str], None] | None = None,
    on_log: Callable[[str], None] | None = None, check_cancel: Callable[[], None] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    _validate_aspect_ratio(aspect_ratio)
    chosen_model = (model or provider.default_model).strip()
    headers = _provider_headers(provider, chosen_model, api_key)
    endpoint = normalize_ark_image_endpoint(provider.base_url)
    if on_progress:
        on_progress(0.15, "Preparing source cover")
    original_size, encoded = await asyncio.to_thread(encode_source_cover_jpeg, source_image_path)
    prompt = build_cover_prompt(
        target_language=target_language, cover_title=cover_title, context_excerpt=context_excerpt,
        custom_prompt=custom_prompt, aspect_ratio=aspect_ratio,
    )
    payload, profile = build_seedream_payload(
        model=chosen_model, prompt=prompt, image_base64=encoded, watermark=watermark,
    )
    if on_progress:
        on_progress(0.35, "Translating cover with Volcengine Seedream")

    image_url = ""
    image_bytes = b""
    async with _build_client(provider.base_url, proxy_url=proxy_url, timeout=120.0, transport=transport) as client:
        for attempt in range(1, 4):
            if check_cancel:
                check_cancel()
            try:
                field, value = await _generate(client, endpoint, headers, payload)
                if field == "b64_json":
                    try:
                        image_bytes = base64.b64decode(value, validate=True)
                    except ValueError as exc:
                        raise AppError(502, "INVALID_PROVIDER_RESULT", "Invalid base64 image from provider.") from exc
                    if len(image_bytes) > MAX_DOWNLOAD_IMAGE_BYTES:
                        raise AppError(502, "INVALID_PROVIDER_RESULT", "Generated cover image exceeds maximum allowed size.")
                else:
                    image_url = value
                break
            except _RETRYABLE_GEN_ERRORS as exc:
                error = _request_error(exc)
                if attempt == 3:
                    raise error from exc
                if on_log:
                    on_log(f"Cover request failed on attempt {attempt}: {error}. Retrying in {attempt}s.")
                if check_cancel:
                    check_cancel()
                await asyncio.sleep(attempt)
            except httpx.TransportError as exc:
                raise _request_error(exc) from exc

    if image_url:
        for attempt in range(1, 4):
            if check_cancel:
                check_cancel()
            try:
                image_bytes = await _download_generated_image(
                    image_url, proxy_url=proxy_url, transport=transport,
                )
                break
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                error = _request_error(exc)
                if attempt == 3:
                    raise error from exc
                if on_log:
                    on_log(f"Cover download failed on attempt {attempt}: {error}. Retrying in {attempt}s.")
                if check_cancel:
                    check_cancel()
                await asyncio.sleep(attempt)

    if check_cancel:
        check_cancel()
    if on_progress:
        on_progress(0.85, "Finalizing translated cover")
    width, height = await asyncio.to_thread(
        postprocess_cover_image,
        image_bytes, output_path, aspect_ratio=aspect_ratio, original_size=original_size,
    )
    if on_progress:
        on_progress(1.0, "Finalizing translated cover")
    return {
        "model": chosen_model, "profile": profile.name, "targetLanguage": target_language,
        "coverTitle": cover_title.strip(), "aspectRatio": aspect_ratio, "width": width, "height": height,
        "prompt": prompt,
    }


async def probe_image_provider(
    provider: ImageProviderConfig, api_key: str, *, proxy_url: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    model = provider.default_model.strip()
    headers = _provider_headers(provider, model, api_key)
    payload, profile = build_seedream_payload(
        model=model, prompt="Make the image blue.", image_base64=_jpeg_base64(Image.new("RGB", (256, 256), "white"))
    )
    started = time.monotonic()
    async with _build_client(provider.base_url, proxy_url=proxy_url, timeout=60.0, transport=transport) as client:
        try:
            await _generate(client, normalize_ark_image_endpoint(provider.base_url), headers, payload)
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            raise _request_error(exc) from exc
    return {
        "ok": True,
        "latencyMs": round((time.monotonic() - started) * 1000),
        "model": model,
        "profile": profile.name,
        "message": "OK",
    }
