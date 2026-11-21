"""Canonical FastAPI application for YouDub."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import shutil
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from .dag import TaskRunner
from .db import Database
from .errors import AppError, install_error_handlers
from .events import EventHub
from .llm import PRESETS, discover_models, probe_connection
from .resources import APP_VERSION, ResourceManager
from .settings import LLMProviderConfig, SettingsStore, ThemeMode, UiLanguage
from .workflows import build_node_types, validate_workflow_document


class SettingsPatchBody(BaseModel):
    ui_language: UiLanguage | None = None
    theme: ThemeMode | None = None
    data_dir: str | None = None
    proxy_url: str | None = None
    youtube_cookies: str | None = None
    clear_youtube_cookies: bool = False


class ProviderUpsertBody(BaseModel):
    name: str
    protocol: str = "openai"
    preset: str = "custom"
    base_url: str = ""
    default_model: str = ""
    models: list[str] = []
    enabled: bool = True
    api_key: str | None = None
    clear_api_key: bool = False


class ProviderProbeBody(BaseModel):
    name: str | None = None
    protocol: str | None = None
    preset: str | None = None
    base_url: str | None = None
    default_model: str | None = None
    api_key: str | None = None


def _read_log_tail(path: Path, lines: int) -> tuple[str, bool]:
    """Read the last `lines` lines without loading an entire large log file into memory."""
    if not path.is_file():
        return "", False
    size = path.stat().st_size
    if size == 0:
        return "", False
    chunk_size = 65536
    data = b""
    pos = size
    newline_count = 0
    truncated = False
    with path.open("rb") as handle:
        while pos > 0 and newline_count <= lines:
            read_len = min(chunk_size, pos)
            pos -= read_len
            handle.seek(pos)
            chunk = handle.read(read_len)
            data = chunk + data
            newline_count = data.count(b"\n")
        if pos > 0:
            truncated = True
    text_lines = data.decode("utf-8", errors="replace").splitlines(keepends=True)
    if len(text_lines) > lines:
        truncated = True
        text_lines = text_lines[-lines:]
    return "".join(text_lines), truncated


def create_app(
    *,
    config_dir: Path | None = None,
    web_dist: Path | None = None,
    auth_token: str | None = None,
    llm_transport: Any = None,
    download_transport: Any = None,
) -> FastAPI:
    settings = SettingsStore(config_dir=config_dir)
    events = EventHub()
    db = Database()
    resources = ResourceManager(settings, events, transport=download_transport)
    runner = TaskRunner(db, settings, resources, events)

    resolved_dist = web_dist
    if resolved_dist is None:
        env_dist = os.getenv("YOUDUB_WEB_DIST", "").strip()
        if env_dist:
            resolved_dist = Path(env_dist).expanduser().resolve()

    resolved_token = auth_token if auth_token is not None else os.getenv("YOUDUB_AUTH_TOKEN", "").strip()

    def _sync_storage() -> None:
        data = settings.data_path()
        if data is not None:
            db.open(data / "youdub.sqlite")
            runner.ensure_seeded_templates()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        events.bind_loop(asyncio.get_running_loop())
        _sync_storage()
        if db.ready:
            db.mark_stale_tasks_failed()
        yield
        db.close()

    app = FastAPI(title="YouDub Runtime", version=APP_VERSION, lifespan=lifespan)
    install_error_handlers(app)

    # Expose internal services for tests and inspection
    app.state.settings = settings
    app.state.events = events
    app.state.db = db
    app.state.resources = resources
    app.state.runner = runner

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^http://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next: Any) -> Response:
        if resolved_token and request.url.path.startswith("/api/") and request.url.path != "/api/health":
            if request.method == "OPTIONS":
                return await call_next(request)
            header = request.headers.get("authorization", "")
            bearer = header[7:].strip() if header.lower().startswith("bearer ") else ""
            query_token = request.query_params.get("token", "").strip()
            candidate = bearer or query_token
            if not candidate or not hmac.compare_digest(candidate, resolved_token):
                return JSONResponse(
                    status_code=401,
                    content={"error": {"code": "UNAUTHORIZED", "message": "Invalid or missing backend token."}},
                )
        return await call_next(request)

    # ------------------------------------------------------------------
    # Health & Real-time SSE
    # ------------------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": APP_VERSION}

    @app.get("/api/system/active-work")
    async def active_work() -> dict[str, Any]:
        return {
            "activeTasks": db.count_active_tasks(),
            "preparingResources": resources.is_preparing(),
        }

    @app.get("/api/events")
    async def event_stream() -> StreamingResponse:
        return StreamingResponse(
            events.subscribe(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------
    # Setup & Settings
    # ------------------------------------------------------------------

    @app.get("/api/setup")
    async def get_setup() -> dict[str, Any]:
        return resources.setup_state()

    @app.post("/api/setup")
    async def post_setup(request: Request) -> dict[str, Any]:
        body = await request.json()
        state = resources.handle_setup_post(body if isinstance(body, dict) else {})
        _sync_storage()
        return state

    @app.get("/api/settings")
    async def get_settings() -> dict[str, Any]:
        return settings.settings_view()

    @app.patch("/api/settings")
    async def patch_settings(body: SettingsPatchBody) -> dict[str, Any]:
        data_changed = body.data_dir is not None and body.data_dir != settings.config.data_dir
        if data_changed and runner.has_active_runs():
            raise AppError(
                409,
                "TASK_ACTIVE",
                "Cancel active tasks before switching the workspace data directory.",
            )
        settings.update_general(
            ui_language=body.ui_language,
            theme=body.theme,
            data_dir=body.data_dir,
            proxy_url=body.proxy_url,
            youtube_cookies=body.youtube_cookies,
            clear_youtube_cookies=body.clear_youtube_cookies,
        )
        if data_changed:
            _sync_storage()
            resources.invalidate_probe_cache()
        view = settings.settings_view()
        events.publish("settings.updated", view)
        if data_changed or body.proxy_url is not None:
            events.publish("resources.updated", {})
        if data_changed:
            events.publish("task.updated", {})
        return view

    # ------------------------------------------------------------------
    # LLM Providers
    # ------------------------------------------------------------------

    @app.get("/api/llm/presets")
    async def list_llm_presets() -> dict[str, Any]:
        return {"items": list(PRESETS.values())}

    @app.get("/api/llm/providers")
    async def list_llm_providers() -> dict[str, Any]:
        return {"items": [settings.provider_view(p) for p in settings.config.llm_providers]}

    @app.put("/api/llm/providers/{provider_id}")
    async def upsert_llm_provider(provider_id: str, body: ProviderUpsertBody) -> dict[str, Any]:
        protocol = body.protocol if body.protocol in {"openai", "anthropic", "gemini"} else "openai"
        cfg = LLMProviderConfig(
            id=provider_id,
            name=body.name.strip() or provider_id,
            protocol=protocol,  # type: ignore[arg-type]
            preset=body.preset,
            base_url=body.base_url.strip(),
            default_model=body.default_model.strip(),
            models=list(dict.fromkeys([m.strip() for m in body.models if m.strip()])),
            enabled=body.enabled,
        )
        settings.upsert_provider(cfg, api_key=body.api_key, clear_api_key=body.clear_api_key)
        view = settings.provider_view(cfg)
        events.publish("providers.updated", {"providerId": provider_id})
        events.publish("settings.updated", settings.settings_view())
        return view

    @app.delete("/api/llm/providers/{provider_id}", status_code=204)
    async def delete_llm_provider(provider_id: str) -> Response:
        settings.delete_provider(provider_id)
        events.publish("providers.updated", {"providerId": provider_id, "deleted": True})
        events.publish("settings.updated", settings.settings_view())
        return Response(status_code=204)

    def _resolve_probe_provider(provider_id: str, body: ProviderProbeBody | None) -> tuple[LLMProviderConfig, str]:
        stored = settings.get_provider(provider_id)
        raw_proto = (body.protocol if body and body.protocol else (stored.protocol if stored else "openai"))
        protocol = raw_proto if raw_proto in {"openai", "anthropic", "gemini"} else "openai"
        cfg = LLMProviderConfig(
            id=provider_id,
            name=(body.name if body and body.name else (stored.name if stored else provider_id)),
            protocol=protocol,  # type: ignore[arg-type]
            preset=(body.preset if body and body.preset else (stored.preset if stored else "custom")),
            base_url=(body.base_url if body and body.base_url is not None else (stored.base_url if stored else "")),
            default_model=(
                body.default_model if body and body.default_model is not None else (stored.default_model if stored else "")
            ),
            models=stored.models if stored else [],
            enabled=True,
        )
        key = (
            body.api_key.strip()
            if body and body.api_key is not None and body.api_key.strip()
            else settings.secrets.get(provider_id)
        )
        return cfg, key

    @app.post("/api/llm/providers/{provider_id}/test")
    async def probe_llm_provider(provider_id: str, body: ProviderProbeBody | None = None) -> dict[str, Any]:
        cfg, key = _resolve_probe_provider(provider_id, body)
        return await probe_connection(
            cfg, key, proxy_url=settings.config.proxy_url, transport=llm_transport
        )

    @app.post("/api/llm/providers/{provider_id}/models")
    async def fetch_llm_models(provider_id: str, body: ProviderProbeBody | None = None) -> dict[str, Any]:
        cfg, key = _resolve_probe_provider(provider_id, body)
        models = await discover_models(
            cfg, key, proxy_url=settings.config.proxy_url, transport=llm_transport
        )
        return {"items": models}

    # ------------------------------------------------------------------
    # Resources & Workflow Catalog
    # ------------------------------------------------------------------

    @app.get("/api/resources")
    async def get_resources() -> dict[str, Any]:
        return resources.inventory()

    @app.post("/api/resources/check")
    async def check_resources(request: Request) -> dict[str, Any]:
        body = await request.json()
        if isinstance(body.get("document"), dict):
            return resources.check_document(body["document"])
        return resources.check(body.get("selections") or [])

    @app.post("/api/resources/prepare")
    async def prepare_resources(request: Request) -> dict[str, Any]:
        body = await request.json()
        return resources.start_prepare(
            selections=body.get("selections"),
            resource_ids=body.get("resourceIds"),
        )

    @app.post("/api/resources/action")
    async def resource_action(request: Request) -> dict[str, Any]:
        body = await request.json()
        return resources.perform_action(str(body.get("action") or ""), body.get("resourceId"))

    @app.get("/api/resources/yt-dlp/check")
    async def check_yt_dlp_update(force: bool = False) -> dict[str, Any]:
        return await resources.check_yt_dlp_update(force=force)

    @app.post("/api/resources/yt-dlp/update")
    async def update_yt_dlp() -> dict[str, Any]:
        return await asyncio.to_thread(resources.update_yt_dlp)

    @app.post("/api/workflow-documents/resources/check")
    async def check_workflow_resources(request: Request) -> dict[str, Any]:
        body = await request.json()
        return resources.check_document(body.get("document") or {})

    @app.post("/api/workflow-documents/resources/prepare")
    async def prepare_workflow_resources(request: Request) -> dict[str, Any]:
        body = await request.json()
        doc = body.get("document") or {}
        return resources.start_prepare(selections=resources.selections_for_document(doc))

    @app.get("/api/node-types")
    async def get_node_types() -> dict[str, Any]:
        return {"items": build_node_types(settings, resources)}

    @app.get("/api/runtime")
    async def get_runtime() -> dict[str, Any]:
        from ..accelerators import detect_devices
        return {
            "devices": detect_devices(),
            "whisperVariants": resources._whisper_variants_payload(),
            "ytDlp": {"version": resources.yt_dlp_version()},
        }

    # ------------------------------------------------------------------
    # Workflow Documents
    # ------------------------------------------------------------------

    @app.get("/api/workflow-documents")
    async def list_workflow_documents(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)) -> dict[str, Any]:
        runner.ensure_seeded_templates()
        return db.list_workflow_documents(limit=limit, offset=offset)

    @app.get("/api/workflow-documents/{doc_id}")
    async def get_workflow_document(doc_id: str) -> dict[str, Any]:
        runner.ensure_seeded_templates()
        return db.get_workflow_document(doc_id)

    @app.post("/api/workflow-documents")
    async def create_workflow_document(request: Request) -> dict[str, Any]:
        body = await request.json()
        doc = body.get("document")
        if not isinstance(doc, dict):
            raise AppError(422, "INVALID_FORMAT", "Expected { document: WorkflowDocument }.")
        return db.upsert_workflow_document(doc, origin="user", create_only=True)

    @app.put("/api/workflow-documents/{doc_id}")
    async def update_workflow_document(doc_id: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        doc = body.get("document")
        if not isinstance(doc, dict):
            raise AppError(422, "INVALID_FORMAT", "Expected { document: WorkflowDocument }.")
        doc = {**doc, "id": doc_id}
        return db.upsert_workflow_document(
            doc,
            origin="user",
            expected_revision=body.get("expectedRevision"),
        )

    @app.delete("/api/workflow-documents/{doc_id}", status_code=204)
    async def delete_workflow_document(doc_id: str, expectedRevision: int | None = None) -> Response:
        db.delete_workflow_document(doc_id, expected_revision=expectedRevision)
        return Response(status_code=204)

    @app.post("/api/workflow-documents/validate")
    async def validate_workflow_endpoint(request: Request) -> dict[str, Any]:
        body = await request.json()
        doc = body.get("document") or {}
        runtime_inputs = body.get("nodeRuntimeInputs")
        valid, diagnostics, _ = validate_workflow_document(
            doc,
            build_node_types(settings, resources),
            runtime_inputs,
        )
        return {"valid": valid, "diagnostics": diagnostics}

    # ------------------------------------------------------------------
    # Tasks, Uploads, Review & Streaming Media
    # ------------------------------------------------------------------

    @app.get("/api/tasks")
    async def list_tasks(
        limit: int = Query(20, ge=1, le=200),
        offset: int = Query(0, ge=0),
        status: str | None = None,
    ) -> dict[str, Any]:
        return db.list_tasks(limit=limit, offset=offset, status=status or None)

    @app.post("/api/tasks")
    async def create_task(request: Request) -> dict[str, Any]:
        content_type = request.headers.get("content-type", "")
        data_root = settings.data_path()
        if data_root is None:
            raise AppError(503, "SETUP_REQUIRED", "Configure workspace data directory first.")

        uploaded: dict[str, Path] = {}
        staging_dir: Path | None = None
        try:
            if "multipart/form-data" in content_type:
                form = await request.form()
                raw_req = form.get("request")
                if not isinstance(raw_req, str):
                    raise AppError(422, "INVALID_REQUEST", "Multipart submission requires a 'request' JSON field.")
                meta = json.loads(raw_req)
                task_id = str(meta.get("id") or uuid.uuid4())
                staging_dir = data_root / "uploads" / task_id
                staging_dir.mkdir(parents=True, exist_ok=True)
                for key, value in form.multi_items():
                    if key.startswith("input.") and isinstance(value, UploadFile):
                        slot = key[len("input.") :]
                        filename = Path(value.filename or f"{slot}.bin").name
                        dest = staging_dir / f"{slot}-{filename}"
                        with dest.open("wb") as out:
                            while chunk := await value.read(1024 * 1024):
                                out.write(chunk)
                        uploaded[slot] = dest
            else:
                meta = await request.json()
                task_id = str(meta.get("id") or uuid.uuid4())

            graph_doc = meta.get("graphDocument")
            if not isinstance(graph_doc, dict):
                raise AppError(422, "INVALID_REQUEST", "Expected graphDocument in task request.")

            return await runner.start_task(
                task_id=task_id,
                graph_document=graph_doc,
                node_runtime_inputs=meta.get("nodeRuntimeInputs") or {},
                uploaded_files=uploaded,
                source_name=str(meta.get("sourceName") or ""),
                document_revision=meta.get("documentRevision"),
                workflow_id=str(meta.get("workflowId") or "youdub.graph"),
                workflow_version=str(meta.get("workflowVersion") or "1.0.0"),
                config=meta.get("config") or {},
            )
        finally:
            if staging_dir and staging_dir.is_dir():
                shutil.rmtree(staging_dir, ignore_errors=True)

    @app.delete("/api/imports/{submission_id}", status_code=204)
    async def discard_import(submission_id: str) -> Response:
        data_root = settings.data_path()
        if data_root is not None:
            staging = data_root / "uploads" / submission_id
            if staging.is_dir():
                shutil.rmtree(staging, ignore_errors=True)
        return Response(status_code=204)

    @app.get("/api/tasks/{task_id}")
    async def get_task(task_id: str) -> dict[str, Any]:
        return db.get_task(task_id)

    @app.delete("/api/tasks/{task_id}", status_code=204)
    async def delete_task(task_id: str, expectedAttempt: int | None = None) -> Response:
        runner.delete_task(task_id, expected_attempt=expectedAttempt)
        return Response(status_code=204)

    @app.post("/api/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str, request: Request) -> dict[str, Any]:
        body = await request.json() if await request.body() else {}
        return await runner.cancel_task(
            task_id,
            expected_attempt=body.get("expectedAttempt"),
            expected_revision=body.get("expectedTaskRevision"),
        )

    @app.post("/api/tasks/{task_id}/retry")
    async def retry_task(task_id: str, request: Request) -> dict[str, Any]:
        body = await request.json() if await request.body() else {}
        return await runner.retry_task(
            task_id,
            expected_attempt=body.get("expectedAttempt"),
            expected_revision=body.get("expectedTaskRevision"),
        )

    @app.post("/api/tasks/{task_id}/rerun-preview")
    async def rerun_preview(task_id: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        return runner.preview_rerun(task_id, body)

    @app.post("/api/tasks/{task_id}/rerun")
    async def rerun_task(task_id: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        return await runner.execute_rerun(task_id, body)

    @app.get("/api/tasks/{task_id}/nodes/{node_id}")
    async def get_node_detail(task_id: str, node_id: str) -> dict[str, Any]:
        return runner.get_node_detail(task_id, node_id)

    @app.post("/api/tasks/{task_id}/nodes/{node_id}/approve")
    async def approve_node(task_id: str, node_id: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        return await runner.approve_node(task_id, node_id, body)

    @app.post("/api/tasks/{task_id}/nodes/{node_id}/corrections")
    async def correct_node(task_id: str, node_id: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        return await runner.correct_node(task_id, node_id, body)

    @app.get("/api/tasks/{task_id}/actions/{action_id}")
    async def get_action(task_id: str, action_id: str) -> dict[str, Any]:
        action = db.get_action(task_id, action_id)
        if action is None:
            raise AppError(404, "ACTION_NOT_FOUND", f"Action {action_id!r} was not applied.")
        return action

    @app.get("/api/tasks/{task_id}/cover")
    async def get_cover(task_id: str) -> FileResponse:
        task = db.get_task(task_id)
        if not task.get("cover"):
            raise AppError(404, "COVER_NOT_FOUND", "Task cover is not available.")
        cover_file = runner.task_dir(task_id) / "cover.jpg"
        if not cover_file.is_file():
            raise AppError(404, "COVER_NOT_FOUND", "Task cover file is missing.")
        return FileResponse(cover_file, media_type="image/jpeg")

    @app.get("/api/tasks/{task_id}/artifacts/{artifact_id}")
    async def get_artifact(task_id: str, artifact_id: str) -> FileResponse:
        path, entry = runner.resolve_artifact_path(task_id, artifact_id)
        return FileResponse(path, media_type=entry.get("mimeType"), filename=entry.get("name"))

    @app.get("/api/tasks/{task_id}/files/{output_id}")
    async def get_output_file(task_id: str, output_id: str) -> FileResponse:
        task = db.get_task(task_id)
        out = next((item for item in task["outputs"] if item["id"] == output_id), None)
        if out is None or not out.get("artifactId"):
            raise AppError(404, "FILE_NOT_FOUND", f"Output {output_id!r} not found.")
        path, entry = runner.resolve_artifact_path(task_id, out["artifactId"])
        return FileResponse(path, media_type=entry.get("mimeType"), filename=entry.get("name"))

    @app.get("/api/tasks/{task_id}/log")
    async def get_task_log(
        task_id: str,
        lines: int = Query(500, ge=1, le=5000),
        full: bool = Query(False),
        download: bool = Query(False),
    ) -> Response:
        db.get_task(task_id)
        log_file = runner.log_path(task_id)
        if not log_file.is_file():
            if download:
                return PlainTextResponse("", headers={"Content-Disposition": f'attachment; filename="task-{task_id}.log"'})
            return PlainTextResponse("", headers={"X-Log-Truncated": "false"})
        if download:
            return FileResponse(
                log_file,
                media_type="text/plain; charset=utf-8",
                filename=f"task-{task_id}.log",
            )
        if full:
            content = log_file.read_text(encoding="utf-8", errors="replace")
            return PlainTextResponse(content, headers={"X-Log-Truncated": "false"})
        tail, truncated = _read_log_tail(log_file, lines)
        return PlainTextResponse(
            tail,
            headers={"X-Log-Truncated": "true" if truncated else "false"},
        )

    # ------------------------------------------------------------------
    # Static SPA Serving (Production / Electron Packaged Mode)
    # ------------------------------------------------------------------

    if resolved_dist is not None and resolved_dist.is_dir():
        dist_root = resolved_dist.resolve()
        index_html = dist_root / "index.html"

        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str) -> Response:
            if full_path.startswith("api/") or full_path == "api":
                return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "Not found."}})
            candidate = (dist_root / full_path).resolve()
            if full_path and candidate.is_relative_to(dist_root) and candidate.is_file():
                return FileResponse(candidate)
            if index_html.is_file():
                return HTMLResponse(index_html.read_text(encoding="utf-8"))
            return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "SPA build missing."}})

    return app
