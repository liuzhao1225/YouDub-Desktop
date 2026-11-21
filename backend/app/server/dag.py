"""DAG workflow scheduler, human-review state machine, artifact registry, and rerun planner."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import mimetypes
import os
import shutil
import signal
import subprocess
import sys
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

from ..paths import now_iso
from ..v1.segments import Transcript, Translation
from .db import Database
from .errors import AppError, TaskCancelledError
from .events import EventHub
from .llm import translate_transcript
from .resources import ResourceManager
from .settings import LLMProviderConfig, SettingsStore
from .video_download import download_video
from .whisper_resegment import parse_srt_transcript
from .workflows import build_node_types, validate_workflow_document

_DEFAULT_DOWNLOAD_VIDEO = download_video


def _sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


class TaskRunner:
    """Executes DAG workflow tasks, manages human-in-the-loop review, and supports reruns."""

    def __init__(
        self,
        db: Database,
        settings: SettingsStore,
        resources: ResourceManager,
        events: EventHub,
    ) -> None:
        self.db = db
        self.settings = settings
        self.resources = resources
        self.events = events
        self._active_runs: dict[str, asyncio.Task[None]] = {}
        self._active_procs: dict[str, asyncio.subprocess.Process] = {}
        self._cancel_flags: set[str] = set()
        self._gpu_lock = asyncio.Semaphore(1)

    def _data_root(self) -> Path:
        root = self.settings.data_path()
        if root is None:
            raise AppError(503, "SETUP_REQUIRED", "Configure workspace data directory first.")
        return root

    def has_active_runs(self) -> bool:
        return any(not task.done() for task in self._active_runs.values())

    def task_dir(self, task_id: str) -> Path:
        return self._data_root() / "tasks" / task_id

    def log_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / "task.log"

    def append_log(self, task_id: str, line: str) -> None:
        path = self.log_path(task_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = f"[{now_iso()}] {line.rstrip()}\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(entry)
        self.events.publish("task.log", {"taskId": task_id, "text": entry})

    def ensure_seeded_templates(self) -> None:
        if not self.db.ready:
            return
        from .workflows import builtin_workflow_templates

        for template in builtin_workflow_templates():
            self.db.seed_builtin_template(template)

    def _node_types(self) -> list[dict[str, Any]]:
        return build_node_types(self.settings, self.resources)

    # ------------------------------------------------------------------
    # Task creation & lifecycle actions
    # ------------------------------------------------------------------

    def _check_not_cancelled(self, task_id: str) -> None:
        if task_id in self._cancel_flags:
            raise TaskCancelledError("Task cancelled by user.")

    def _save_input_artifacts(
        self,
        task_id: str,
        graph: dict[str, Any],
        uploaded_files: dict[str, Path],
    ) -> dict[str, dict[str, Any]]:
        tdir = self.task_dir(task_id)
        inp_dir = tdir / "inputs"
        inp_dir.mkdir(parents=True, exist_ok=True)
        artifacts: dict[str, dict[str, Any]] = {}
        for g_in in graph.get("inputs") or []:
            port_id = g_in["id"]
            src = uploaded_files.get(port_id)
            if src is not None and src.is_file():
                dst = inp_dir / f"{port_id}-{src.name}"
                if src.resolve() != dst.resolve():
                    shutil.copy2(src, dst)
                art_id = f"input:{port_id}"
                artifacts[art_id] = {
                    "id": art_id,
                    "schemaId": g_in.get("schemaId", "file/v1"),
                    "path": str(dst),
                    "name": src.name,
                    "mimeType": mimetypes.guess_type(src.name)[0] or "application/octet-stream",
                    "size": dst.stat().st_size,
                }
        self._persist_artifact_index(task_id, artifacts)
        return artifacts

    def _artifact_index_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / "artifacts.json"

    def _load_artifact_index(self, task_id: str) -> dict[str, dict[str, Any]]:
        p = self._artifact_index_path(task_id)
        if not p.is_file():
            return {}
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _persist_artifact_index(self, task_id: str, artifacts: dict[str, dict[str, Any]]) -> None:
        p = self._artifact_index_path(task_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        existing = self._load_artifact_index(task_id)
        existing.update(artifacts)
        p.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")

    def resolve_artifact_path(self, task_id: str, artifact_id: str) -> tuple[Path, dict[str, Any]]:
        index = self._load_artifact_index(task_id)
        entry = index.get(artifact_id)
        if not entry:
            raise AppError(404, "ARTIFACT_NOT_FOUND", f"Artifact {artifact_id!r} not found for task {task_id}.")
        p = Path(entry["path"]).resolve()
        if not p.is_file():
            raise AppError(404, "ARTIFACT_NOT_FOUND", f"Artifact file for {artifact_id!r} is missing on disk.")
        return p, entry

    def _make_initial_steps(self, graph: dict[str, Any], node_types: list[dict[str, Any]]) -> list[dict[str, Any]]:
        _, _, topo = validate_workflow_document(graph, node_types)
        node_map = {n["id"]: n for n in graph["nodes"]}
        def_map = {(d["type"], d["version"], d["providerId"]): d for d in node_types}
        steps: list[dict[str, Any]] = []
        for nid in topo:
            node = node_map[nid]
            pid = (node.get("provider") or {}).get("id", "")
            ndef = def_map.get((node["type"], node["typeVersion"], pid)) or next(
                (d for d in node_types if d["type"] == node["type"]), None
            )
            label = node.get("label") or (ndef["label"] if ndef else nid)
            steps.append(
                {
                    "id": nid,
                    "label": label,
                    "status": "pending",
                    "progress": None,
                    "providerId": pid,
                    "message": None,
                    "error": None,
                }
            )
        return steps

    async def start_task(
        self,
        *,
        task_id: str | None = None,
        graph_document: dict[str, Any],
        node_runtime_inputs: dict[str, Any] | None = None,
        uploaded_files: dict[str, Path] | None = None,
        source_name: str = "",
        document_revision: int | None = None,
        workflow_id: str = "youdub.graph",
        workflow_version: str = "1.0.0",
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        node_types = self._node_types()
        runtime_inputs = node_runtime_inputs or {}
        valid, diagnostics, _ = validate_workflow_document(graph_document, node_types, runtime_inputs)
        if not valid:
            raise AppError(422, "INVALID_GRAPH", diagnostics[0]["message"], details=diagnostics)

        tid = task_id or str(uuid.uuid4())
        # Idempotent return if submission with exact same task id already exists
        try:
            return self.db.get_task(tid)
        except AppError:
            pass

        files = uploaded_files or {}
        for gin in graph_document.get("inputs") or []:
            if gin.get("required") and gin["id"] not in files:
                raise AppError(422, "MISSING_INPUT_FILE", f"Required workflow input {gin['id']!r} was not uploaded.")

        resolved_source_name = source_name.strip() or (
            next((p.name for p in files.values()), "") or graph_document.get("title") or "Workflow task"
        )
        steps = self._make_initial_steps(graph_document, node_types)
        task = self.db.create_task(
            {
                "id": tid,
                "attempt": 1,
                "revision": 1,
                "status": "queued",
                "sourceName": resolved_source_name,
                "workflowId": workflow_id,
                "workflowVersion": workflow_version,
                "documentId": graph_document.get("id"),
                "documentRevision": document_revision,
                "documentTitle": graph_document.get("title"),
                "config": config or {},
                "graphSnapshot": graph_document,
                "nodeRuntimeInputs": runtime_inputs,
                "steps": steps,
                "outputs": [],
            }
        )
        artifacts = self._save_input_artifacts(tid, graph_document, files)
        # Extract thumbnail immediately if an input video was uploaded
        video_art = artifacts.get("input:video")
        if video_art:
            self._maybe_extract_cover(tid, Path(video_art["path"]))
            task = self.db.get_task(tid)

        self.append_log(tid, f"Task queued: {resolved_source_name}")
        self.events.publish("task.updated", {"taskId": tid, "status": "queued"})
        self._spawn_runner(tid)
        return task

    def _spawn_runner(self, task_id: str) -> None:
        existing = self._active_runs.get(task_id)
        if existing is not None and not existing.done():
            return
        self._cancel_flags.discard(task_id)
        loop = asyncio.get_running_loop()
        self._active_runs[task_id] = loop.create_task(self._execute_task(task_id))

    async def cancel_task(
        self,
        task_id: str,
        *,
        expected_attempt: int | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        task = self.db.get_task(task_id)
        if task["status"] in {"succeeded", "cancelled", "failed"}:
            return task
        self._cancel_flags.add(task_id)
        updated = self.db.update_task(
            task_id,
            status="cancelling",
            message="Cancelling task...",
            expected_attempt=expected_attempt,
            expected_revision=expected_revision,
        )
        self.append_log(task_id, "Cancellation requested by user.")
        proc = self._active_procs.get(task_id)
        if proc is not None and proc.returncode is None:
            self._terminate_process_tree(proc)

        # If task was paused awaiting review (no runner running), transition directly to cancelled
        runner = self._active_runs.get(task_id)
        if runner is None or runner.done():
            steps = [
                {**s, "status": "cancelled" if s["status"] in {"pending", "awaiting_review"} else s["status"]}
                for s in updated["steps"]
            ]
            updated = self.db.update_task(task_id, status="cancelled", steps=steps, message="Cancelled")
        self.events.publish("task.updated", {"taskId": task_id, "status": updated["status"]})
        return updated

    async def retry_task(
        self,
        task_id: str,
        *,
        expected_attempt: int | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        task = self.db.get_task(task_id)
        if task["status"] not in {"failed", "cancelled"}:
            raise AppError(409, "INVALID_STATE", "Only failed or cancelled tasks can be continued.")
        steps = [
            {**s, "status": "pending", "error": None, "message": None}
            if s["status"] in {"failed", "cancelled", "running", "waiting"}
            else s
            for s in task["steps"]
        ]
        updated = self.db.update_task(
            task_id,
            status="queued",
            attempt=task["attempt"] + 1,
            steps=steps,
            error=None,
            message="Resuming task...",
            expected_attempt=expected_attempt,
            expected_revision=expected_revision,
        )
        self.append_log(task_id, f"Continuing task (attempt {updated['attempt']}).")
        self.events.publish("task.updated", {"taskId": task_id, "status": "queued"})
        self._spawn_runner(task_id)
        return updated

    def delete_task(self, task_id: str, *, expected_attempt: int | None = None) -> None:
        self.db.delete_task(task_id, expected_attempt=expected_attempt)
        tdir = self.task_dir(task_id)
        if tdir.is_dir():
            shutil.rmtree(tdir, ignore_errors=True)
        self.events.publish("task.deleted", {"taskId": task_id})

    # ------------------------------------------------------------------
    # Human review & corrections
    # ------------------------------------------------------------------

    def get_node_detail(self, task_id: str, node_id: str) -> dict[str, Any]:
        task = self.db.get_task(task_id)
        graph = task["graphSnapshot"]
        node = next((n for n in graph["nodes"] if n["id"] == node_id), None)
        if node is None:
            raise AppError(404, "NODE_NOT_FOUND", f"Node {node_id!r} not found in task {task_id}.")
        step = next(s for s in task["steps"] if s["id"] == node_id)
        node_types = self._node_types()
        ndef = next(
            (d for d in node_types if d["type"] == node["type"] and d["providerId"] == (node.get("provider") or {}).get("id")),
            next((d for d in node_types if d["type"] == node["type"]), None),
        )
        revisions = self.db.get_node_results(task_id, node_id)
        latest = revisions[-1] if revisions else None
        approved = next((r["revision"] for r in reversed(revisions) if r.get("approved")), None)
        resolved_inputs = self._gather_node_inputs_for_detail(task_id, graph, node_id)

        step_view = {**step, **({"outputs": latest["outputs"]} if latest else {})}
        return {
            "taskId": task_id,
            "nodeId": node_id,
            "taskRevision": task["revision"],
            "attempt": task["attempt"],
            "status": task["status"],
            "step": step_view,
            "spec": {
                "operation": ndef["operation"] if ndef else node["type"],
                "input": node.get("config") or {},
                "outputs": ndef.get("outputs", []) if ndef else [],
                "autoContinue": bool(node.get("autoContinue", True)),
            },
            "inputs": resolved_inputs,
            "resultRevisions": [
                {
                    "revision": r["revision"],
                    "parentRevision": r["parentRevision"],
                    "source": r["source"],
                    "actionId": r["actionId"],
                    "outputs": r["outputs"],
                    "createdAt": r["createdAt"],
                }
                for r in revisions
            ],
            "outputRevision": latest["revision"] if latest else 0,
            "approvedRevision": approved,
        }

    def _gather_node_inputs_for_detail(self, task_id: str, graph: dict[str, Any], node_id: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        artifacts = self._load_artifact_index(task_id)
        for edge in graph.get("edges") or []:
            if edge["target"]["nodeId"] != node_id:
                continue
            port_id = edge["target"]["portId"]
            src_nid = edge["source"]["nodeId"]
            src_port = edge["source"]["portId"]
            if src_nid == "$inputs":
                art = artifacts.get(f"input:{src_port}")
                if art:
                    result[port_id] = {"$artifact": art["id"], "id": art["id"], "name": art["name"], "schemaId": art["schemaId"]}
            else:
                revs = self.db.get_node_results(task_id, src_nid)
                if revs and src_port in revs[-1]["outputs"]:
                    result[port_id] = revs[-1]["outputs"][src_port]
        return result

    def _validate_correction_patch(
        self,
        task_id: str,
        graph: dict[str, Any],
        node_id: str,
        merged_outputs: dict[str, Any],
    ) -> None:
        if "transcript" in merged_outputs and merged_outputs["transcript"] is not None:
            try:
                Transcript.model_validate(merged_outputs["transcript"])
            except Exception as exc:
                raise AppError(422, "INVALID_CORRECTION", f"Invalid transcript correction: {exc}") from exc
        if "translation" in merged_outputs and merged_outputs["translation"] is not None:
            try:
                translation = Translation.model_validate(merged_outputs["translation"])
            except Exception as exc:
                raise AppError(422, "INVALID_CORRECTION", f"Invalid translation correction: {exc}") from exc
            inputs = self._gather_node_inputs_for_detail(task_id, graph, node_id)
            if isinstance(inputs.get("transcript"), dict):
                try:
                    transcript = Transcript.model_validate(inputs["transcript"])
                    translation.match(transcript)
                except Exception as exc:
                    raise AppError(422, "INVALID_CORRECTION", f"Translation correction mismatch: {exc}") from exc

    async def approve_node(self, task_id: str, node_id: str, body: dict[str, Any]) -> dict[str, Any]:
        action_id = str(body.get("actionId") or "")
        if action_id and self.db.get_action(task_id, action_id):
            return self.db.get_task(task_id)

        task = self.db.get_task(task_id)
        self._assert_expected_revisions(task, task_id, node_id, body)
        revs = self.db.get_node_results(task_id, node_id)
        if not revs:
            raise AppError(409, "NO_RESULT", "Node has no computed output to approve.")
        latest_rev = int(body.get("expectedOutputRevision") or revs[-1]["revision"])
        self.db.mark_node_approved(task_id, node_id, latest_rev, action_id=action_id or None)
        return self._complete_node_review_and_resume(task, node_id)

    async def correct_node(self, task_id: str, node_id: str, body: dict[str, Any]) -> dict[str, Any]:
        action_id = str(body.get("actionId") or "")
        if action_id and self.db.get_action(task_id, action_id):
            return self.db.get_task(task_id)

        task = self.db.get_task(task_id)
        self._assert_expected_revisions(task, task_id, node_id, body)
        revs = self.db.get_node_results(task_id, node_id)
        if not revs:
            raise AppError(409, "NO_RESULT", "Node has no result to correct.")
        parent_rev = revs[-1]["revision"]
        patch = body.get("patch") or {}
        merged = {**revs[-1]["outputs"], **patch}
        self._validate_correction_patch(task_id, task["graphSnapshot"], node_id, merged)

        should_continue = bool(body.get("continue", False))
        self.db.add_node_result(
            task_id,
            node_id,
            source="correction",
            outputs=merged,
            parent_revision=parent_rev,
            action_id=action_id or None,
            approved=should_continue,
        )
        self.append_log(task_id, f"Saved manual correction on node '{node_id}'.")
        if should_continue:
            return self._complete_node_review_and_resume(task, node_id)

        updated = self.db.update_task(task_id)
        self.events.publish("task.updated", {"taskId": task_id, "status": updated["status"]})
        return updated

    def _assert_expected_revisions(
        self, task: dict[str, Any], task_id: str, node_id: str, body: dict[str, Any]
    ) -> None:
        if body.get("expectedAttempt") is not None and body["expectedAttempt"] != task["attempt"]:
            raise AppError(409, "CONFLICT", "Task attempt changed; reload before submitting.")
        if body.get("expectedTaskRevision") is not None and body["expectedTaskRevision"] != task["revision"]:
            raise AppError(409, "CONFLICT", "Task state changed elsewhere; reload before submitting.")
        step = next((s for s in task["steps"] if s["id"] == node_id), None)
        if step is None:
            raise AppError(404, "NODE_NOT_FOUND", f"Node {node_id!r} not found.")
        if step["status"] != "awaiting_review":
            raise AppError(409, "NOT_AWAITING_REVIEW", "This node is not currently awaiting approval.")
        revs = self.db.get_node_results(task_id, node_id)
        current_rev = revs[-1]["revision"] if revs else 0
        if body.get("expectedOutputRevision") is not None and body["expectedOutputRevision"] != current_rev:
            raise AppError(409, "CONFLICT", "A newer node output exists; reload before submitting.")

    def _complete_node_review_and_resume(self, task: dict[str, Any], node_id: str) -> dict[str, Any]:
        task_id = task["id"]
        steps = [
            {**s, "status": "completed", "progress": 1.0, "message": "Approved"}
            if s["id"] == node_id
            else s
            for s in task["steps"]
        ]
        all_done = all(s["status"] == "completed" for s in steps)
        still_paused = any(s["status"] == "awaiting_review" for s in steps)
        if all_done:
            outputs = self._build_final_task_outputs(task_id, task["graphSnapshot"])
            updated = self.db.update_task(task_id, status="succeeded", steps=steps, outputs=outputs, message="Completed")
            self.append_log(task_id, "Task completed after review.")
        elif still_paused:
            updated = self.db.update_task(task_id, status="paused", steps=steps, message="Awaiting review")
        else:
            updated = self.db.update_task(task_id, status="running", steps=steps, message="Continuing workflow...")
            self._spawn_runner(task_id)
        self.events.publish("task.updated", {"taskId": task_id, "status": updated["status"]})
        return updated

    # ------------------------------------------------------------------
    # Rerun preview & derived tasks
    # ------------------------------------------------------------------

    def preview_rerun(self, task_id: str, body: dict[str, Any]) -> dict[str, Any]:
        source = self.db.get_task(task_id)
        if source["status"] not in {"succeeded", "failed", "cancelled"}:
            raise AppError(409, "TASK_NOT_TERMINAL", "Wait for the task to finish or cancel it before rerunning.")
        if body.get("expectedAttempt") is not None and body["expectedAttempt"] != source["attempt"]:
            raise AppError(409, "CONFLICT", "Source task attempt changed.")
        if body.get("expectedTaskRevision") is not None and body["expectedTaskRevision"] != source["revision"]:
            raise AppError(409, "CONFLICT", "Source task revision changed.")

        next_doc = body.get("graphDocument") or source["graphSnapshot"]
        node_types = self._node_types()
        runtime_inputs = body.get("nodeRuntimeInputs") if body.get("nodeRuntimeInputs") is not None else source.get("nodeRuntimeInputs", {})
        valid, diagnostics, topo = validate_workflow_document(next_doc, node_types, runtime_inputs)
        if not valid:
            raise AppError(422, "INVALID_GRAPH", diagnostics[0]["message"], details=diagnostics)

        corrections = body.get("corrections") or {}
        old_nodes = {n["id"]: n for n in source["graphSnapshot"]["nodes"]}
        old_edges_by_target: dict[str, dict[str, Any]] = {}
        for e in source["graphSnapshot"]["edges"]:
            old_edges_by_target.setdefault(e["target"]["nodeId"], {})[e["target"]["portId"]] = e["source"]
        new_nodes = {n["id"]: n for n in next_doc["nodes"]}
        new_edges_by_target: dict[str, dict[str, Any]] = {}
        for e in next_doc["edges"]:
            new_edges_by_target.setdefault(e["target"]["nodeId"], {})[e["target"]["portId"]] = e["source"]

        dirty_set: set[str] = set()
        reused: list[str] = []
        dirty: list[str] = []
        source_revisions: dict[str, int] = {}

        for nid in topo:
            new_node = new_nodes[nid]
            old_node = old_nodes.get(nid)
            revs = self.db.get_node_results(task_id, nid)
            has_completed = bool(revs) and any(s["id"] == nid and s["status"] == "completed" for s in source["steps"])

            if nid in corrections and revs:
                # Applying a correction directly onto `nid` updates `nid`'s output revision
                # cleanly without recomputing `nid` itself; downstream nodes become dirty!
                reused.append(nid)
                source_revisions[nid] = revs[-1]["revision"]
                # Mark all dependents downstream as dirty
                for e in next_doc["edges"]:
                    if e["source"]["nodeId"] == nid:
                        dirty_set.add(e["target"]["nodeId"])
                continue

            upstream_dirty = any(
                e["source"]["nodeId"] in dirty_set
                for e in next_doc["edges"]
                if e["target"]["nodeId"] == nid and e["source"]["nodeId"] != "$inputs"
            )
            node_changed = (
                old_node is None
                or old_node.get("type") != new_node.get("type")
                or old_node.get("provider") != new_node.get("provider")
                or old_node.get("config") != new_node.get("config")
                or old_edges_by_target.get(nid, {}) != new_edges_by_target.get(nid, {})
                or source.get("nodeRuntimeInputs", {}).get(nid) != runtime_inputs.get(nid)
            )
            if nid in dirty_set or upstream_dirty or node_changed or not has_completed:
                dirty_set.add(nid)
                dirty.append(nid)
            else:
                reused.append(nid)
                source_revisions[nid] = revs[-1]["revision"]

        return {
            "reusedSteps": reused,
            "dirtySteps": dirty,
            "expectedAttempt": source["attempt"],
            "expectedTaskRevision": source["revision"],
            "sourceRevisions": source_revisions,
        }

    async def execute_rerun(self, source_task_id: str, body: dict[str, Any]) -> dict[str, Any]:
        new_id = str(body.get("id") or uuid.uuid4())
        try:
            return self.db.get_task(new_id)
        except AppError:
            pass

        preview = self.preview_rerun(source_task_id, body)
        source = self.db.get_task(source_task_id)
        next_doc = body.get("graphDocument") or source["graphSnapshot"]
        runtime_inputs = body.get("nodeRuntimeInputs") if body.get("nodeRuntimeInputs") is not None else source.get("nodeRuntimeInputs", {})
        corrections = body.get("corrections") or {}

        node_types = self._node_types()
        steps = self._make_initial_steps(next_doc, node_types)
        reused_set = set(preview["reusedSteps"])
        for step in steps:
            if step["id"] in reused_set:
                step["status"] = "completed"
                step["progress"] = 1.0
                step["message"] = "Reused"

        derived = self.db.create_task(
            {
                "id": new_id,
                "attempt": 1,
                "revision": 1,
                "status": "queued",
                "sourceName": source["sourceName"],
                "workflowId": next_doc.get("id", "youdub.graph"),
                "workflowVersion": "1.0.0",
                "documentId": next_doc.get("id"),
                "documentRevision": source.get("workflowSource", {}).get("documentRevision"),
                "documentTitle": next_doc.get("title"),
                "config": body.get("config") or {},
                "graphSnapshot": next_doc,
                "nodeRuntimeInputs": runtime_inputs,
                "steps": steps,
                "outputs": [],
            }
        )

        # Hardlink (zero extra disk blocks) or copy reused artifacts so deleting parent never breaks derived task
        src_artifacts = self._load_artifact_index(source_task_id)
        reused_dir = self.task_dir(new_id) / "reused"
        reused_dir.mkdir(parents=True, exist_ok=True)
        cloned_artifacts: dict[str, dict[str, Any]] = {}
        for art_id, entry in src_artifacts.items():
            owner_nid = art_id.split(":", 1)[0]
            if art_id.startswith("input:") or owner_nid in reused_set:
                src_p = Path(entry["path"])
                if src_p.is_file():
                    safe_name = f"{art_id.replace(':', '_')}-{src_p.name}"
                    dst_p = reused_dir / safe_name
                    if not dst_p.exists():
                        try:
                            os.link(src_p, dst_p)
                        except OSError:
                            shutil.copy2(src_p, dst_p)
                    cloned_artifacts[art_id] = {**entry, "path": str(dst_p)}
        self._persist_artifact_index(new_id, cloned_artifacts)
        if source.get("cover"):
            src_cover = self.task_dir(source_task_id) / "cover.jpg"
            if src_cover.is_file():
                dst_cover = self.task_dir(new_id) / "cover.jpg"
                dst_cover.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_cover, dst_cover)
                self.db.update_task(new_id, cover_path="cover.jpg")

        # Carry over reused node result revisions + apply correction patches cleanly
        for nid in preview["reusedSteps"]:
            revs = self.db.get_node_results(source_task_id, nid)
            if not revs:
                continue
            outputs = copy.deepcopy(revs[-1]["outputs"])
            if nid in corrections:
                patch = corrections[nid].get("patch") or {}
                outputs = {**outputs, **patch}
                self._validate_correction_patch(source_task_id, next_doc, nid, outputs)
                self.db.add_node_result(new_id, nid, source="correction", outputs=outputs, approved=True)
            else:
                self.db.add_node_result(new_id, nid, source="computed", outputs=outputs, approved=True)

        self.append_log(new_id, f"Derived task created from {source_task_id} (reused: {len(preview['reusedSteps'])}, rerun: {len(preview['dirtySteps'])}).")
        self.events.publish("task.updated", {"taskId": new_id, "status": "queued"})
        self._spawn_runner(new_id)
        return self.db.get_task(new_id)

    # ------------------------------------------------------------------
    # Internal execution engine
    # ------------------------------------------------------------------

    def _terminate_process_tree(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
        except OSError:
            pass

    async def _run_stage_subprocess(self, task_id: str, node_id: str, spec: dict[str, Any]) -> dict[str, Any]:
        py = self.resources.compute_python()
        if not py:
            raise AppError(503, "PYTHON_NOT_READY", "Python compute runtime is not configured.")
        work_dir = Path(spec["workDir"])
        work_dir.mkdir(parents=True, exist_ok=True)
        spec_path = work_dir / "stage_spec.json"
        result_path = work_dir / "stage_result.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        if result_path.exists():
            result_path.unlink()

        repo_root = Path(__file__).resolve().parents[3]
        env = self.resources.child_process_env()
        proc = await asyncio.create_subprocess_exec(
            py,
            "-m",
            "backend.app.server.stage_worker",
            str(spec_path),
            str(result_path),
            cwd=str(repo_root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
        self._active_procs[task_id] = proc
        try:
            async def _read_stdout() -> None:
                assert proc.stdout is not None
                while line := await proc.stdout.readline():
                    self._check_not_cancelled(task_id)
                    text = line.decode("utf-8", errors="replace").strip()
                    if not text:
                        continue
                    try:
                        evt = json.loads(text)
                        if evt.get("event") == "progress":
                            self._update_step_progress(task_id, node_id, evt.get("progress"), evt.get("message", ""))
                            self.append_log(task_id, f"[{node_id}] {evt.get('message', '')}")
                            continue
                    except ValueError:
                        pass
                    self.append_log(task_id, f"[{node_id}] {text}")

            async def _watch_cancel() -> None:
                while proc.returncode is None:
                    if task_id in self._cancel_flags:
                        self._terminate_process_tree(proc)
                        raise TaskCancelledError("Cancelled while running stage.")
                    await asyncio.sleep(0.15)

            stdout_task = asyncio.create_task(_read_stdout())
            cancel_task = asyncio.create_task(_watch_cancel())
            try:
                await proc.wait()
            finally:
                cancel_task.cancel()
                try:
                    await cancel_task
                except (asyncio.CancelledError, TaskCancelledError):
                    pass
                await stdout_task

            self._check_not_cancelled(task_id)
            if not result_path.is_file():
                stderr_tail = ""
                if proc.stderr is not None:
                    stderr_tail = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()[-500:]
                raise AppError(502, "STAGE_FAILED", stderr_tail or f"Stage process exited with code {proc.returncode}.")
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if not result.get("ok"):
                raise AppError(502, result.get("code", "STAGE_FAILED"), result.get("message", "Stage failed."))
            return result
        except TaskCancelledError:
            self._terminate_process_tree(proc)
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            raise
        finally:
            self._active_procs.pop(task_id, None)

    def _update_step_status(
        self,
        task_id: str,
        node_id: str,
        *,
        status: str,
        progress: float | None = None,
        message: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        task = self.db.get_task(task_id)
        steps = [
            {
                **s,
                "status": status,
                "progress": progress if progress is not None else s.get("progress"),
                "message": message if message is not None else s.get("message"),
                "error": {"message": error} if error else None,
            }
            if s["id"] == node_id
            else s
            for s in task["steps"]
        ]
        updated = self.db.update_task(task_id, steps=steps, message=message or task.get("message"))
        self.events.publish("task.updated", {"taskId": task_id, "status": updated["status"]})
        return updated

    def _update_step_progress(self, task_id: str, node_id: str, progress: float | None, message: str) -> None:
        try:
            task = self.db.get_task(task_id)
        except AppError:
            return
        steps = [
            {**s, "progress": progress, "message": message} if s["id"] == node_id else s
            for s in task["steps"]
        ]
        self.db.update_task(task_id, steps=steps, message=message)
        self.events.publish("task.updated", {"taskId": task_id, "status": task["status"]})

    def _maybe_extract_cover(self, task_id: str, video_path: Path) -> None:
        ff, _ = self.resources.resolve_ffmpeg()
        if not ff or not video_path.is_file():
            return
        cover_file = self.task_dir(task_id) / "cover.jpg"
        try:
            proc = subprocess.run(
                [ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", str(video_path), "-vframes", "1", str(cover_file)],
                capture_output=True,
                timeout=15,
            )
            if proc.returncode == 0 and cover_file.is_file() and cover_file.stat().st_size > 0:
                self.db.update_task(task_id, cover_path="cover.jpg")
        except (OSError, subprocess.SubprocessError):
            pass

    def _register_node_artifacts(self, task_id: str, node_id: str, paths: dict[str, str]) -> dict[str, Any]:
        entries: dict[str, dict[str, Any]] = {}
        outputs: dict[str, Any] = {}
        for port_name, raw_path in paths.items():
            p = Path(raw_path).resolve()
            if not p.is_file():
                continue
            art_id = f"{node_id}:{port_name}"
            mime = mimetypes.guess_type(p.name)[0] or (
                "application/x-subrip" if p.suffix.lower() == ".srt" else "application/octet-stream"
            )
            schema_id = (
                "video/mp4/v1"
                if mime.startswith("video/")
                else "audio/wav/v1"
                if mime.startswith("audio/")
                else "application/x-subrip/v1"
                if p.suffix.lower() == ".srt"
                else "file/v1"
            )
            entries[art_id] = {
                "id": art_id,
                "schemaId": schema_id,
                "path": str(p),
                "name": p.name,
                "mimeType": mime,
                "size": p.stat().st_size,
            }
            outputs[port_name] = {
                "$artifact": art_id,
                "id": art_id,
                "name": p.name,
                "mimeType": mime,
                "schemaId": schema_id,
                "size": p.stat().st_size,
            }
        self._persist_artifact_index(task_id, entries)
        return outputs

    def _build_final_task_outputs(self, task_id: str, graph: dict[str, Any]) -> list[dict[str, Any]]:
        artifacts = self._load_artifact_index(task_id)
        outputs: list[dict[str, Any]] = []
        for gout in graph.get("outputs") or []:
            src = gout.get("source") or {}
            src_nid, src_port = src.get("nodeId"), src.get("portId")
            art_id = f"input:{src_port}" if src_nid == "$inputs" else f"{src_nid}:{src_port}"
            entry = artifacts.get(art_id)
            if not entry:
                continue
            out_id = gout["id"]
            # Map artifact lookup consistently
            outputs.append(
                {
                    "id": out_id,
                    "name": entry["name"],
                    "label": gout.get("label") or out_id,
                    "mimeType": entry["mimeType"],
                    "url": f"/api/tasks/{task_id}/files/{out_id}",
                    "size": entry["size"],
                    "artifactId": art_id,
                }
            )
        return outputs

    def _collect_node_inputs_for_exec(
        self, task_id: str, graph: dict[str, Any], node_id: str
    ) -> dict[str, str]:
        """Materialize file/JSON inputs for one node execution inside its work directory."""
        node_dir = self.task_dir(task_id) / "nodes" / node_id / "inputs"
        node_dir.mkdir(parents=True, exist_ok=True)
        artifacts = self._load_artifact_index(task_id)
        resolved: dict[str, str] = {}

        for edge in graph.get("edges") or []:
            if edge["target"]["nodeId"] != node_id:
                continue
            port_id = edge["target"]["portId"]
            src_nid = edge["source"]["nodeId"]
            src_port = edge["source"]["portId"]
            if src_nid == "$inputs":
                entry = artifacts.get(f"input:{src_port}")
                if entry:
                    resolved[port_id] = entry["path"]
                continue

            revs = self.db.get_node_results(task_id, src_nid)
            if not revs:
                raise AppError(500, "MISSING_UPSTREAM", f"Missing upstream result from {src_nid}.")
            latest_outputs = revs[-1]["outputs"]
            val = latest_outputs.get(src_port)
            if isinstance(val, dict) and "$artifact" in val:
                entry = artifacts.get(val["$artifact"])
                if entry:
                    resolved[port_id] = entry["path"]
            elif val is not None:
                json_file = node_dir / f"{port_id}.json"
                json_file.write_text(json.dumps(val, ensure_ascii=False, indent=2), encoding="utf-8")
                resolved[port_id] = str(json_file)
        return resolved

    async def _execute_node(self, task_id: str, graph: dict[str, Any], node: dict[str, Any], runtime_inputs: dict[str, Any]) -> dict[str, Any]:
        node_id = node["id"]
        ntype = node["type"]
        provider = node.get("provider") or {}
        cfg = node.get("config") or {}
        work_dir = self.task_dir(task_id) / "nodes" / node_id
        work_dir.mkdir(parents=True, exist_ok=True)
        in_files = self._collect_node_inputs_for_exec(task_id, graph, node_id)

        if ntype == "youdub.download":
            url = str((runtime_inputs.get(node_id) or {}).get("url") or "")
            proxy_port = int(cfg.get("proxyPort") or 0)
            self.append_log(task_id, f"[{node_id}] Downloading video: {url}")
            ff, _ = self.resources.resolve_ffmpeg()
            raw_host = (
                urllib.parse.urlparse(url if "://" in url else f"https://{url}").hostname or ""
            ).lower()
            is_youtube = (
                raw_host in {"youtu.be", "youtube.com", "youtube-nocookie.com"}
                or raw_host.endswith((".youtube.com", ".youtube-nocookie.com"))
                or ("://" not in url and "." not in url and "/" not in url and len(url.strip()) == 11)
            )
            cookies_text = (
                self.settings.secrets.get(self.settings.YOUTUBE_COOKIES_SECRET_KEY)
                if is_youtube
                else None
            )
            cookie_path: Path | None = None
            if cookies_text:
                work_dir.mkdir(parents=True, exist_ok=True)
                cookie_path = work_dir / ".cookies.txt"
                cookie_path.write_text(cookies_text.rstrip("\n") + "\n", encoding="utf-8")
                os.chmod(cookie_path, 0o600)
            try:
                if download_video is not _DEFAULT_DOWNLOAD_VIDEO:
                    video_path, meta = await asyncio.to_thread(
                        download_video,
                        url,
                        work_dir,
                        proxy_port=proxy_port,
                        proxy_url=self.settings.config.proxy_url,
                        ffmpeg_location=ff,
                        cookiefile=str(cookie_path) if cookie_path else None,
                        check_cancel=lambda: self._check_not_cancelled(task_id),
                        progress=lambda ratio, msg: self._update_step_progress(task_id, node_id, ratio, msg),
                    )
                else:
                    dl_spec: dict[str, Any] = {
                        "operation": "video.download/v1",
                        "workDir": str(work_dir),
                        "config": cfg,
                        "provider": provider,
                        "inputFiles": {},
                        "url": url,
                        "proxyUrl": self.settings.config.proxy_url,
                        "ffmpegLocation": ff,
                        "cookiefile": str(cookie_path) if cookie_path else None,
                    }
                    dl_result = await self._run_stage_subprocess(task_id, node_id, dl_spec)
                    video_path = Path(dl_result["artifacts"]["video"]).resolve()
                    meta = dl_result.get("outputs", {}).get("metadata") or {}
            finally:
                if cookie_path is not None:
                    cookie_path.unlink(missing_ok=True)
            self._maybe_extract_cover(task_id, video_path)
            title = str(meta.get("title") or "").strip()
            if title:
                cur_task = self.db.get_task(task_id)
                cur_name = str(cur_task.get("sourceName") or "").strip()
                if not cur_name or cur_name.startswith(("http://", "https://")):
                    self.db.update_task(task_id, source_name=title)
            outputs = self._register_node_artifacts(task_id, node_id, {"video": str(video_path)})
            outputs["metadata"] = meta
            return outputs

        if ntype == "youdub.importSubtitles":
            srt_path = Path(in_files["subtitles"])
            transcript = parse_srt_transcript(
                srt_path.read_text(encoding="utf-8", errors="replace"),
                language=str(cfg.get("sourceLanguage") or "en"),
            )
            return {"transcript": transcript}

        if ntype == "youdub.translate":
            pid = str(provider.get("id") or "openai")
            llm_cfg = self.settings.get_provider(pid)
            if llm_cfg is None:
                raise AppError(422, "PROVIDER_NOT_CONFIGURED", f"Translation provider {pid!r} is not configured.")
            api_key = self.settings.secrets.get(llm_cfg.id)
            transcript = json.loads(Path(in_files["transcript"]).read_text(encoding="utf-8"))
            self.append_log(task_id, f"[{node_id}] Translating {len(transcript.get('segments', []))} segments via {llm_cfg.name}")
            translation = await translate_transcript(
                transcript,
                source_language=str(cfg.get("sourceLanguage") or "auto"),
                target_language=str(cfg.get("targetLanguage") or "zh"),
                provider=llm_cfg,
                api_key=api_key,
                checkpoint_root=self.task_dir(task_id),
                model=provider.get("model"),
                max_completion_tokens=cfg.get("maxCompletionTokens"),
                proxy_url=self.settings.config.proxy_url,
                on_progress=lambda ratio, msg: self._update_step_progress(task_id, node_id, ratio, msg),
                on_log=lambda msg: self.append_log(task_id, msg),
                check_cancel=lambda: self._check_not_cancelled(task_id),
            )
            return {"translation": translation}

        # All other stages execute cleanly in isolated ML/media child processes
        has_dubbing = any(
            n["type"] in {"youdub.synthesize", "youdub.mix"} for n in graph["nodes"]
        )
        has_subtitles = any(
            out.get("schemaId") == "application/x-subrip/v1"
            for out in (graph.get("outputs") or [])
        ) or any(
            n["type"] == "youdub.export" and n.get("config", {}).get("renderSubtitles")
            for n in graph["nodes"]
        )
        node_types = self._node_types()
        ndef = next((d for d in node_types if d["type"] == ntype), None)
        mix_node = next((n for n in graph["nodes"] if n["type"] == "youdub.mix"), None)
        synth_node = next((n for n in graph["nodes"] if n["type"] == "youdub.synthesize"), None)
        artifact_index = self._load_artifact_index(task_id)
        spec: dict[str, Any] = {
            "operation": ndef["operation"] if ndef else ntype,
            "workDir": str(work_dir),
            "config": cfg,
            "provider": provider,
            "inputFiles": in_files,
            "hasDubbing": has_dubbing,
            "hasSubtitles": has_subtitles,
        }
        if synth_node:
            prefix = f"{synth_node['id']}:speech-"
            speech_keys = sorted(k for k in artifact_index if k.startswith(prefix))
            if speech_keys:
                spec["speechClipPaths"] = [artifact_index[k]["path"] for k in speech_keys]
        if mix_node:
            spec["mixWorkDir"] = str(self.task_dir(task_id) / "nodes" / mix_node["id"])
            adj_prefix = f"{mix_node['id']}:adjusted-"
            adj_keys = sorted(k for k in artifact_index if k.startswith(adj_prefix))
            if adj_keys:
                spec["mixAdjustedPaths"] = [artifact_index[k]["path"] for k in adj_keys]

        async with self._gpu_lock:
            result = await self._run_stage_subprocess(task_id, node_id, spec)

        outputs = dict(result.get("outputs") or {})
        outputs.update(self._register_node_artifacts(task_id, node_id, result.get("artifacts") or {}))
        if result.get("extraArtifacts"):
            self._register_node_artifacts(task_id, node_id, result["extraArtifacts"])
        # Also register individual synthesized speech segments as artifacts for inline audio playback
        if ntype == "youdub.synthesize" and isinstance(outputs.get("speechAudio"), dict):
            extra_paths = {}
            for seg in outputs["speechAudio"].get("segments", []):
                if seg.get("artifactPath"):
                    extra_paths[seg["artifactId"]] = seg["artifactPath"]
            reg = self._register_node_artifacts(task_id, node_id, extra_paths)
            for seg in outputs["speechAudio"].get("segments", []):
                art = reg.get(seg.get("artifactId"))
                if art:
                    seg["audio"] = {"id": art["id"], "schemaId": "audio/wav/v1"}
        return outputs

    async def _execute_task(self, task_id: str) -> None:
        try:
            task = self.db.update_task(task_id, status="running", message="Starting workflow...")
            self.events.publish("task.updated", {"taskId": task_id, "status": "running"})
            graph = task["graphSnapshot"]
            node_map = {n["id"]: n for n in graph["nodes"]}
            runtime_inputs = task.get("nodeRuntimeInputs") or {}
            node_types = self._node_types()
            _, _, topo = validate_workflow_document(graph, node_types, runtime_inputs)

            for node_id in topo:
                self._check_not_cancelled(task_id)
                current = self.db.get_task(task_id)
                step = next(s for s in current["steps"] if s["id"] == node_id)
                if step["status"] == "completed":
                    continue
                if step["status"] == "awaiting_review":
                    self.db.update_task(task_id, status="paused", message="Awaiting human review")
                    self.events.publish("task.updated", {"taskId": task_id, "status": "paused"})
                    return

                self._update_step_status(task_id, node_id, status="running", progress=None, message=f"Running {node_id}...")
                self.append_log(task_id, f"Starting step: {node_id} ({node_map[node_id]['type']})")

                node = node_map[node_id]
                outputs = await self._execute_node(task_id, graph, node, runtime_inputs)
                self._check_not_cancelled(task_id)

                auto_continue = bool(node.get("autoContinue", True))
                self.db.add_node_result(
                    task_id,
                    node_id,
                    source="computed",
                    outputs=outputs,
                    approved=auto_continue,
                )

                if not auto_continue:
                    self._update_step_status(
                        task_id,
                        node_id,
                        status="awaiting_review",
                        progress=1.0,
                        message="Awaiting review",
                    )
                    self.db.update_task(task_id, status="paused", message="Awaiting human review")
                    self.append_log(task_id, f"Paused at step '{node_id}' for human review.")
                    self.events.publish("task.updated", {"taskId": task_id, "status": "paused"})
                    return

                self._update_step_status(task_id, node_id, status="completed", progress=1.0, message="Done")
                self.append_log(task_id, f"Completed step: {node_id}")

            final_outputs = self._build_final_task_outputs(task_id, graph)
            self.db.update_task(task_id, status="succeeded", outputs=final_outputs, message="Completed")
            self.append_log(task_id, "Workflow finished successfully.")
            self.events.publish("task.updated", {"taskId": task_id, "status": "succeeded"})
        except TaskCancelledError:
            task = self.db.get_task(task_id)
            steps = [
                {**s, "status": "cancelled" if s["status"] in {"running", "waiting", "pending"} else s["status"]}
                for s in task["steps"]
            ]
            self.db.update_task(task_id, status="cancelled", steps=steps, message="Cancelled")
            self.append_log(task_id, "Task cancelled.")
            self.events.publish("task.updated", {"taskId": task_id, "status": "cancelled"})
        except Exception as exc:
            err_msg = exc.message if isinstance(exc, AppError) else str(exc)
            err_code = exc.code if isinstance(exc, AppError) else "TASK_FAILED"
            task = self.db.get_task(task_id)
            steps = [
                {**s, "status": "failed", "error": {"code": err_code, "message": err_msg}} if s["status"] in {"running", "waiting"} else s
                for s in task["steps"]
            ]
            self.db.update_task(
                task_id,
                status="failed",
                steps=steps,
                message=err_msg,
                error={"code": err_code, "message": err_msg},
            )
            self.append_log(task_id, f"ERROR [{err_code}]: {err_msg}")
            self.events.publish("task.updated", {"taskId": task_id, "status": "failed"})
        finally:
            self._cancel_flags.discard(task_id)
            self._active_runs.pop(task_id, None)
