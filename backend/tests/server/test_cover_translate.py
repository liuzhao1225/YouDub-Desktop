"""Cover editing contracts from Ark request construction through downloadable DAG results."""

import asyncio
import base64
import json
import time
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app.server import cover_translate as cover
from backend.app.server import stage_worker, video_download
from backend.app.server.api import create_app
from backend.app.server.errors import AppError
from backend.app.server.settings import ImageProviderConfig, LLMProviderConfig

MODEL = "doubao-seedream-5-5-261028"
BASE = "https://ark.cn-beijing.volces.com/api/v3"
ENDPOINT = BASE + "/images/generations"
IMAGE_URL = "https://images.example.test/result.png"
PROVIDER_URL = "/api/image/providers/volcengine"
KEY = "fake-cover-provider-key"


def png(color="white"):
    buffer = BytesIO()
    Image.new("RGB", (64, 32), color).save(buffer, format="PNG")
    return buffer.getvalue()


def b64_result():
    return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})


@pytest.mark.parametrize("watermark", [True, False])
@pytest.mark.parametrize(("model", "profile"), [
    (MODEL, "seedream-5.5"),
    ("doubao-seedream-5-0-pro-260501", "seedream-5.5"),
    ("doubao-seedream-5-0-flash-260501", "seedream-5.5"),
    ("ep-20260101-abcde", "seedream-5.5"),
    ("doubao-seedream-5-0-260128", "seedream-4.x"),
    ("doubao-seedream-5.0-260128", "seedream-4.x"),
    ("doubao-seedream-5-0-lite-260128", "seedream-4.x"),
    ("doubao-seedream-4-5-251128", "seedream-4.x"),
    ("doubao-seedream-4-0-250828", "seedream-4.x"),
    ("doubao-seededit-3-0-i2i-250628", "seededit-3.0"),
])
def test_seedream_payload(model, profile, watermark):
    payload, resolved = cover.build_seedream_payload(
        model=model, prompt="edit title", image_base64="YWJj", watermark=watermark,
    )
    assert resolved == cover.resolve_seedream_profile(model)
    assert resolved.name == profile
    data_url = "data:image/jpeg;base64,YWJj"
    assert payload["model"] == model and payload["prompt"] == "edit title"
    assert payload["watermark"] is watermark
    assert payload["image"] == (data_url if profile == "seededit-3.0" else [data_url])
    assert payload["size"] == ("adaptive" if profile == "seededit-3.0" else "2K")
    if profile == "seedream-4.x":
        assert payload["sequential_image_generation"] == "disabled"
    else:
        assert "sequential_image_generation" not in payload


@pytest.mark.parametrize("url", [BASE, BASE + "/", ENDPOINT])
def test_ark_endpoint(url):
    assert cover.normalize_ark_image_endpoint(url) == ENDPOINT


@pytest.mark.parametrize("ratio", ["original", "4:3_padded", "16:9"])
@pytest.mark.parametrize(("language", "translate", "replace", "original"), [
    ("zh", "翻译成简体中文", "替换为中文标题", "原图宽高比"),
    ("en", "Translate all visible text", "Replace the existing title", "original aspect ratio"),
    ("ja", "日本語に翻訳", "差し替え", "元画像の縦横比"),
])
def test_localized_prompts(language, translate, replace, original, ratio):
    args = dict(target_language=language, context_excerpt="Chapter eleven", aspect_ratio=ratio)
    prompt = cover.build_cover_prompt(**args, custom_prompt="Keep the illustration")
    assert translate in prompt and "Chapter eleven" in prompt and "Keep the illustration" in prompt
    titled = cover.build_cover_prompt(**args, cover_title="New title")
    assert replace in titled and "New title" in titled and "Chapter eleven" not in titled
    for result in (prompt, titled):
        assert (original if ratio == "original" else "16:9") in result


def test_unsupported_prompt_language():
    with pytest.raises(AppError) as error:
        cover.build_cover_prompt(target_language="fr")
    assert (error.value.status_code, error.value.code) == (422, "INVALID_CONFIG")


def patterned_png(size: tuple[int, int]):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    side = min(size) // 4
    cx, cy = size[0] // 2, size[1] // 2
    draw.rectangle([cx - side, cy - side, cx + side - 1, cy + side - 1], fill=(220, 40, 40))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize(("ratio", "size"), [
    ("original", (93, 71)), ("16:9", (1280, 720)), ("4:3_padded", (1280, 960)),
])
def test_postprocess(tmp_path, ratio, size):
    path = tmp_path / "cover.jpg"
    assert cover.postprocess_cover_image(png(), path, aspect_ratio=ratio, original_size=(93, 71)) == size
    with Image.open(path) as image:
        assert (image.format, image.size) == ("JPEG", size)
        assert image.getpixel((size[0] // 2, size[1] // 2)) == (255, 255, 255)
        if ratio == "4:3_padded":
            for y in (0, 119, 840, 959):
                assert image.getpixel((640, y)) == (0, 0, 0)
            for y in (120, 839):
                assert image.getpixel((640, y)) == (255, 255, 255)


def test_postprocess_preserves_aspect_without_stretching_and_caps_source_encode(tmp_path):
    # 4:3 input containing a 200x200 red square fitted into 16:9 must keep equal width & height.
    wide_out = tmp_path / "fit-16-9.jpg"
    cover.postprocess_cover_image(patterned_png((800, 600)), wide_out, aspect_ratio="16:9", original_size=(800, 600))
    with Image.open(wide_out) as fitted:
        assert fitted.size == (1280, 720)
        red_xs = [x for x in range(fitted.width) if fitted.getpixel((x, 360))[0] > 180 and fitted.getpixel((x, 360))[1] < 90]
        red_ys = [y for y in range(fitted.height) if fitted.getpixel((640, y))[0] > 180 and fitted.getpixel((640, y))[1] < 90]
        assert abs(len(red_xs) - len(red_ys)) <= 2 and len(red_xs) > 300

    # Large 4K source downscales for Ark payload while returning the true original dimensions.
    huge = tmp_path / "huge.png"
    huge.write_bytes(patterned_png((4096, 2048)))
    orig_size, b64 = cover.encode_source_cover_jpeg(huge)
    assert orig_size == (4096, 2048)
    with Image.open(BytesIO(base64.b64decode(b64, validate=True))) as encoded:
        assert max(encoded.size) == 2048 and encoded.size == (2048, 1024)


def test_invalid_provider_image(tmp_path):
    with pytest.raises(AppError) as error:
        cover.postprocess_cover_image(b"invalid", tmp_path / "cover.jpg", aspect_ratio="original", original_size=(2, 2))
    assert (error.value.status_code, error.value.code) == (502, "INVALID_PROVIDER_RESULT")


def translate(tmp_path, handler):
    source = tmp_path / "source.png"
    source.write_bytes(png("black"))
    return asyncio.run(cover.translate_cover(
        source, tmp_path / "cover.jpg", provider=ImageProviderConfig(), api_key=KEY,
        transport=httpx.MockTransport(handler),
    ))


@pytest.mark.parametrize(("field", "generation_error", "download_error"), [
    ("b64_json", None, None), ("url", None, None), ("b64_json", 429, None),
    ("b64_json", 500, None), ("url", None, 500),
])
def test_translate_delivery_and_retries(tmp_path, field, generation_error, download_error):
    requests = []

    def respond(request):
        url = str(request.url)
        requests.append((request.method, url))
        if url == ENDPOINT:
            assert request.headers["authorization"] == f"Bearer {KEY}"
            if generation_error and len(requests) == 1:
                return httpx.Response(generation_error)
            if field == "b64_json":
                return b64_result()
            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
        assert url == IMAGE_URL
        if download_error and requests.count(("GET", IMAGE_URL)) == 1:
            return httpx.Response(download_error)
        return httpx.Response(200, content=png())

    translate(tmp_path, respond)
    expected = [("POST", ENDPOINT)] * (2 if generation_error else 1)
    if field == "url":
        expected.extend([("GET", IMAGE_URL)] * (2 if download_error else 1))
    assert requests == expected
    with Image.open(tmp_path / "cover.jpg") as image:
        assert image.format == "JPEG" and image.getpixel((0, 0)) == (255, 255, 255)


@pytest.mark.parametrize(("status", "code"), [(401, "IMAGE_AUTH_ERROR"), (400, "COVER_TRANSLATE_FAILED")])
def test_translate_fails_without_copy_or_retry(tmp_path, status, code):
    respond = Mock(return_value=httpx.Response(status))
    with pytest.raises(AppError) as error:
        translate(tmp_path, respond)
    assert error.value.code == code
    respond.assert_called_once()
    assert not (tmp_path / "cover.jpg").exists()


def test_read_timeout_on_generate_does_not_duplicate_billable_post(tmp_path):
    calls = 0

    def respond(_request):
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("slow ark response")

    with pytest.raises(AppError) as error:
        translate(tmp_path, respond)
    assert error.value.code == "COVER_TRANSLATE_FAILED"
    assert calls == 1


def test_download_follows_redirects_retries_timeout_and_does_not_misclassify_cdn_403(tmp_path):
    seen = []

    def respond(request):
        url = str(request.url)
        seen.append((request.method, url))
        if url == ENDPOINT:
            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
        if url == IMAGE_URL and seen.count(("GET", IMAGE_URL)) == 1:
            raise httpx.ReadTimeout("transient cdn read timeout")
        if url == IMAGE_URL:
            return httpx.Response(302, headers={"Location": "https://cdn.example.test/final.png"})
        assert url == "https://cdn.example.test/final.png"
        return httpx.Response(200, content=png())

    translate(tmp_path, respond)
    assert seen.count(("POST", ENDPOINT)) == 1
    assert seen == [
        ("POST", ENDPOINT),
        ("GET", IMAGE_URL),
        ("GET", IMAGE_URL),
        ("GET", "https://cdn.example.test/final.png"),
    ]

    # CDN 403 must report COVER_TRANSLATE_FAILED instead of IMAGE_AUTH_ERROR.
    def cdn_403(request):
        if str(request.url) == ENDPOINT:
            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
        return httpx.Response(403, text="Signed URL expired")

    with pytest.raises(AppError) as cdn_err:
        translate(tmp_path, cdn_403)
    assert cdn_err.value.code == "COVER_TRANSLATE_FAILED"

    # Non-http(s) image URLs are rejected before any GET request.
    def bad_scheme(request):
        return httpx.Response(200, json={"data": [{"url": "file:///etc/passwd"}]})

    with pytest.raises(AppError) as scheme_err:
        translate(tmp_path, bad_scheme)
    assert scheme_err.value.code == "INVALID_PROVIDER_RESULT"


def test_download_enforces_size_limit_while_streaming(monkeypatch, tmp_path):
    body_read = False
    yielded_chunks = 0

    class HeaderLimitStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            nonlocal body_read
            body_read = True
            yield b"should-not-be-read"

    def oversized_header(request):
        if str(request.url) == ENDPOINT:
            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
        return httpx.Response(
            200,
            headers={"content-length": str(cover.MAX_DOWNLOAD_IMAGE_BYTES + 1)},
            stream=HeaderLimitStream(),
        )

    with pytest.raises(AppError) as header_err:
        translate(tmp_path, oversized_header)
    assert header_err.value.code == "INVALID_PROVIDER_RESULT"
    assert body_read is False

    class ChunkedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            nonlocal yielded_chunks
            for _ in range(10):
                yielded_chunks += 1
                yield b"x" * 1024

    monkeypatch.setattr(cover, "MAX_DOWNLOAD_IMAGE_BYTES", 4096)

    def oversized_chunks(request):
        if str(request.url) == ENDPOINT:
            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
        return httpx.Response(200, stream=ChunkedStream())

    with pytest.raises(AppError) as stream_err:
        translate(tmp_path, oversized_chunks)
    assert stream_err.value.code == "INVALID_PROVIDER_RESULT"
    assert yielded_chunks == 5


def assert_probe(result):
    assert result["ok"] is True
    assert (result["model"], result["profile"]) == (MODEL, "seedream-5.5")
    assert isinstance(result["latencyMs"], int) and result["latencyMs"] >= 0


@pytest.mark.parametrize("status", [200, 401])
def test_probe(status):
    handler = Mock(return_value=b64_result() if status == 200 else httpx.Response(status))
    probe = cover.probe_image_provider(ImageProviderConfig(), KEY, transport=httpx.MockTransport(handler))
    if status == 200:
        assert_probe(asyncio.run(probe))
    else:
        with pytest.raises(AppError) as error:
            asyncio.run(probe)
        assert error.value.code == "IMAGE_AUTH_ERROR"
    handler.assert_called_once()


def graph(schema="image/png/v1"):
    return {
        "format": "youdub.workflow", "formatVersion": 1, "id": "cover-test", "title": "Cover",
        "nodes": [{"id": "edit", "type": "youdub.translateCover", "typeVersion": "1.0.0",
                   "provider": {"id": "volcengine"}, "config": {}, "autoContinue": True}],
        "inputs": [{"id": "media", "kind": "artifact", "schemaId": schema, "required": True}],
        "edges": [{"id": "media", "source": {"nodeId": "$inputs", "portId": "media"},
                   "target": {"nodeId": "edit", "portId": "cover"}}],
        "outputs": [{"id": "poster", "kind": "artifact", "schemaId": "image/jpeg/v1",
                     "source": {"nodeId": "edit", "portId": "cover"}}],
    }


@pytest.fixture
def server(tmp_path):
    requests = []

    def respond(request):
        assert (request.method, str(request.url)) == ("POST", ENDPOINT)
        assert request.headers["authorization"] == f"Bearer {KEY}"
        requests.append(json.loads(request.content))
        return b64_result()

    transport = httpx.MockTransport(respond)
    app = create_app(config_dir=tmp_path / "cfg", llm_transport=transport)
    with TestClient(app) as client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")}).raise_for_status()
        yield client, transport, requests


def configure(client, **key_fields):
    response = client.put(PROVIDER_URL, json={
        "name": "Ark", "base_url": BASE, "default_model": MODEL, "models": [MODEL], **key_fields,
    })
    response.raise_for_status()
    assert KEY not in response.text
    return response.json()


def test_provider_lifecycle_and_resources(server, tmp_path):
    client, _, requests = server

    def views():
        for route, field in [("/api/settings", "image_providers"), ("/api/image/providers", "items")]:
            response = client.get(route)
            response.raise_for_status()
            assert KEY not in response.text
            yield next(p for p in response.json()[field] if p["id"] == "volcengine")

    def requirement():
        response = client.post("/api/resources/check", json={"document": graph()})
        response.raise_for_status()
        return next(r for r in response.json()["requirements"] if r["providerId"] == "volcengine")

    for view in views():
        assert view["default_model"] == MODEL and view["available"] is False
    assert requirement()["configurationRequired"] is True
    updated = configure(client, api_key=KEY)
    for view in [updated, *views()]:
        assert view["available"] is True and view["hasApiKey"] is True
        assert view["apiKeyHint"] == "fake...-key"
    store = client.app.state.settings.secrets
    assert store.get("image:volcengine") == KEY
    assert KEY not in (tmp_path / "cfg" / "config.json").read_text()
    assert requirement()["ready"] is True
    result = client.post(PROVIDER_URL + "/test")
    result.raise_for_status()
    assert_probe(result.json())
    assert len(requests) == 1

    # Changing host or explicitly clearing key during probe must never send stored credentials.
    changed_host = client.post(PROVIDER_URL + "/test", json={"base_url": "https://other.example/api/v3"})
    assert changed_host.status_code == 422 and changed_host.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"
    cleared_probe = client.post(PROVIDER_URL + "/test", json={"clear_api_key": True})
    assert cleared_probe.status_code == 422 and cleared_probe.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"
    assert len(requests) == 1

    # Custom default_model must become models[0] in provider view and node catalog.
    custom = configure(client, default_model="ep-20260101-custom", models=[MODEL, "ep-20260101-custom"])
    assert custom["models"][0] == "ep-20260101-custom"
    node_types = client.get("/api/node-types").json()["items"]
    cover_def = next(item for item in node_types if item["type"] == "youdub.translateCover")
    assert cover_def["provider"]["models"][0] == "ep-20260101-custom"

    cleared = configure(client, clear_api_key=True)
    assert cleared["hasApiKey"] is False and cleared["available"] is False
    assert not store.has("image:volcengine")


@pytest.fixture
def dag_server(server):
    client, _transport, requests = server
    configure(client, api_key=KEY)
    return client, requests


def run_graph(client, document, *, files=None, runtime=None):
    payload = {"graphDocument": document, "nodeRuntimeInputs": runtime or {}}
    if files:
        created = client.post("/api/tasks", data={"request": json.dumps(payload)}, files=files)
    else:
        created = client.post("/api/tasks", json=payload)
    assert created.status_code == 200, created.text
    url = "/api/tasks/" + created.json()["id"]
    deadline = time.monotonic() + 10
    while True:
        task = client.get(url).json()
        if task["status"] not in {"running", "queued"} or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    assert task["status"] == "succeeded", task
    outputs = client.get(url + "/nodes/edit").json()["resultRevisions"][-1]["outputs"]
    assert outputs["cover"]["schemaId"] == "image/jpeg/v1"
    meta = outputs["coverMeta"]
    assert (meta["model"], meta["width"], meta["height"]) == (MODEL, 1280, 720)
    output, = task["outputs"]
    assert output["artifactId"] == outputs["cover"]["$artifact"]
    assert task["cover"]["url"]
    assert client.get(task["cover"]["url"]).status_code == 200
    response = client.get(f"{url}/files/{output['id']}")
    response.raise_for_status()
    with Image.open(BytesIO(response.content)) as image:
        assert (image.format, image.size) == ("JPEG", (1280, 720))
        assert image.getpixel((640, 360)) == (255, 255, 255)
    source_cover = meta["sourceCover"]
    src_resp = client.get(f"{url}/artifacts/{source_cover['id']}")
    assert src_resp.status_code == 200
    assert source_cover["schemaId"].startswith("image/")
    return url, task, meta


def test_image_task_and_title_rerun(dag_server):
    client, requests = dag_server
    document = graph()
    runtime = {"edit": {"coverTitle": "First title"}}
    url, task, meta = run_graph(client, document, runtime=runtime, files={
        "input.media": ("poster.png", png("black"), "image/png"),
    })
    assert meta["coverTitle"] == "First title"
    request, = requests
    assert "First title" in request["prompt"]
    body = {"graphDocument": document, "expectedAttempt": task["attempt"], "expectedTaskRevision": task["revision"]}
    for title, dirty in [("First title", []), ("Second title", ["edit"])]:
        preview = client.post(url + "/rerun-preview", json={**body, "nodeRuntimeInputs": {"edit": {"coverTitle": title}}})
        preview.raise_for_status()
        assert preview.json()["dirtySteps"] == dirty

    # Empty runtime title normalization: omitted vs {} vs {"coverTitle": ""} must reuse without rerunning.
    _, blank_task, _ = run_graph(client, document, files={
        "input.media": ("poster.png", png("black"), "image/png"),
    })
    blank_body = {"graphDocument": document, "expectedAttempt": blank_task["attempt"], "expectedTaskRevision": blank_task["revision"]}
    for candidate in ({}, {"edit": {}}, {"edit": {"coverTitle": ""}}):
        preview = client.post(url.rsplit("/", 1)[0] + f"/{blank_task['id']}/rerun-preview", json={**blank_body, "nodeRuntimeInputs": candidate})
        preview.raise_for_status()
        assert preview.json()["dirtySteps"] == []


def test_resource_collision_ffmpeg_preflight_disabled_and_required_output(server, monkeypatch):
    client, _, _ = server
    settings = client.app.state.settings
    # Even if an LLM provider shares the "volcengine" ID and is ready, image provider readiness wins for translateCover.
    settings.upsert_provider(
        LLMProviderConfig(id="volcengine", name="Ark LLM", base_url=BASE, default_model="doubao-pro"),
        api_key="llm-key",
    )
    doc = graph("video/mp4/v1")
    monkeypatch.setattr(client.app.state.resources, "resolve_ffmpeg", lambda: (None, None))
    check = client.post("/api/resources/check", json={"document": doc}).json()
    reqs = {r["providerId"]: r for r in check["requirements"]}
    assert reqs["volcengine"]["configurationRequired"] is True
    assert reqs["youdub.media"]["ready"] is False

    # Disabled image provider must fail execution instead of executing.
    configure(client, api_key=KEY, enabled=False)
    created = client.post("/api/tasks", data={"request": json.dumps({"graphDocument": graph("image/png/v1")})}, files={
        "input.media": ("poster.png", png("black"), "image/png"),
    })
    assert created.status_code == 200
    tid = created.json()["id"]
    for _ in range(40):
        task = client.get(f"/api/tasks/{tid}").json()
        if task["status"] not in {"queued", "running"}:
            break
        time.sleep(0.05)
    assert task["status"] == "failed" and task["error"]["code"] == "PROVIDER_NOT_CONFIGURED"

    # Missing required workflow output must fail instead of succeeding.
    configure(client, api_key=KEY, enabled=True)
    missing_out_doc = graph("image/png/v1")
    missing_out_doc["outputs"].append({
        "id": "missing", "kind": "artifact", "schemaId": "image/jpeg/v1",
        "required": True, "source": {"nodeId": "edit", "portId": "nonexistent"},
    })
    bad_created = client.post("/api/tasks", data={"request": json.dumps({"graphDocument": missing_out_doc})}, files={
        "input.media": ("poster.png", png("black"), "image/png"),
    })
    assert bad_created.status_code == 200
    bad_tid = bad_created.json()["id"]
    for _ in range(40):
        bad_task = client.get(f"/api/tasks/{bad_tid}").json()
        if bad_task["status"] not in {"queued", "running"}:
            break
        time.sleep(0.05)
    assert bad_task["status"] == "failed" and bad_task["error"]["code"] == "MISSING_OUTPUT"

    # Corrupt image/* input fails cleanly as undecodable image without invoking FFmpeg frame extraction.
    extract_spy = Mock(side_effect=AssertionError("FFmpeg must not run on image/* inputs"))
    monkeypatch.setattr(client.app.state.runner, "_extract_cover_frame", extract_spy)
    corrupt_created = client.post("/api/tasks", data={"request": json.dumps({"graphDocument": graph("image/png/v1")})}, files={
        "input.media": ("broken.png", b"not-an-image", "image/png"),
    })
    assert corrupt_created.status_code == 200
    corrupt_tid = corrupt_created.json()["id"]
    for _ in range(40):
        corrupt_task = client.get(f"/api/tasks/{corrupt_tid}").json()
        if corrupt_task["status"] not in {"queued", "running"}:
            break
        time.sleep(0.05)
    assert corrupt_task["status"] == "failed" and corrupt_task["error"]["code"] == "INVALID_MEDIA"
    extract_spy.assert_not_called()


def test_save_thumbnail_pillow_and_ffmpeg_fallback(tmp_path, monkeypatch):
    downloaded = tmp_path / "source.mp4"
    downloaded.write_bytes(b"video")

    # 1. Pillow EXIF orientation conversion and source cleanup.
    thumb = tmp_path / "source.webp"
    Image.new("RGB", (40, 20), "red").save(thumb, format="PNG")
    out = video_download._save_thumbnail(tmp_path, downloaded, "ffmpeg")
    assert out == tmp_path / "cover.jpg" and out.is_file() and not thumb.exists()

    # 2. Corrupt file triggers ffmpeg fallback before cleanup.
    bad_thumb = tmp_path / "source.jpg"
    bad_thumb.write_bytes(b"not-a-pil-image")
    seen_cmd = []

    def fake_run(cmd, **_kw):
        seen_cmd.append(cmd)
        tmp_out = Path(cmd[-1])
        Image.new("RGB", (40, 20), "blue").save(tmp_out, format="JPEG")
        return type("Proc", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(video_download.subprocess, "run", fake_run)
    fallback_out = video_download._save_thumbnail(tmp_path, downloaded, "/usr/bin/ffmpeg")
    assert seen_cmd and seen_cmd[0][0] == "/usr/bin/ffmpeg"
    assert fallback_out == tmp_path / "cover.jpg" and not bad_thumb.exists()


def assert_requested_source(requests, color):
    request, = requests
    image_url, = request["image"]
    prefix, encoded = image_url.split(",", 1)
    assert prefix == "data:image/jpeg;base64"
    with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as source:
        assert source.size == (64, 32) and source.getpixel((32, 16)) == color


@pytest.mark.parametrize("port", ["cover", "video"])
def test_download_uses_thumbnail(dag_server, monkeypatch, port):
    client, requests = dag_server
    runner = client.app.state.runner
    extract = Mock(side_effect=AssertionError("Unexpected video frame extraction"))
    monkeypatch.setattr(runner, "_extract_cover_frame", extract)
    url = "https://example.test/video"

    def download(source_url, work_dir, **kwargs):
        assert source_url == url
        video = work_dir / "source.mp4"
        video.write_bytes(b"test video")
        thumbnail = work_dir / "cover.jpg"
        Image.new("RGB", (64, 32), "black").save(thumbnail)
        return video, {"title": "Downloaded video title", "coverPath": str(thumbnail)}

    async def run_worker(task_id, node_id, spec):
        assert spec["operation"] == "video.download/v1"
        return stage_worker.execute_spec(spec)

    monkeypatch.setattr(stage_worker, "download_video", download)
    monkeypatch.setattr(runner, "_run_stage_subprocess", run_worker)
    document = graph()
    document["inputs"] = []
    document["nodes"].insert(0, {"id": "download", "type": "youdub.download", "typeVersion": "1.0.0",
                                 "provider": {"id": "youdub.download"}, "config": {}, "autoContinue": True})
    document["edges"][0]["source"] = {"nodeId": "download", "portId": port}
    run_graph(client, document, runtime={"download": {"url": url}})
    extract.assert_not_called()
    assert_requested_source(requests, (0, 0, 0))
    assert "Downloaded video title" in requests[0]["prompt"]


def test_video_input_extracts_frame(dag_server, monkeypatch):
    client, requests = dag_server

    def extract(video, frame):
        assert video.read_bytes() == b"video without a thumbnail"
        Image.new("RGB", (64, 32), "black").save(frame)

    extract_frame = Mock(side_effect=extract)
    monkeypatch.setattr(client.app.state.runner, "_extract_cover_frame", extract_frame)
    run_graph(client, graph("video/mp4/v1"), files={
        "input.media": ("input.mp4", b"video without a thumbnail", "video/mp4"),
    })
    extract_frame.assert_called_once()
    assert_requested_source(requests, (0, 0, 0))


def test_connected_translation_supplies_context(dag_server):
    client, requests = dag_server
    document = graph()
    document["inputs"].append({"id": "translation", "kind": "json", "schemaId": "youdub.translation/v1",
                               "required": True})
    document["edges"].append({"id": "context", "source": {"nodeId": "$inputs", "portId": "translation"},
                              "target": {"nodeId": "edit", "portId": "translation"}})
    translation = {"source_language": "en", "target_language": "zh",
                   "segments": [{"segment_id": "one", "text": "发现古城"}, {"segment_id": "two", "text": "穿过城门"}]}
    _, _, meta = run_graph(client, document, files={
        "input.media": ("poster.png", png(), "image/png"),
        "input.translation": ("translation.json", json.dumps(translation), "application/json"),
    })
    request, = requests
    assert meta["coverTitle"] == ""
    assert "发现古城 穿过城门" in request["prompt"]
