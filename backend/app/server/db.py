"""Clean SQLite WAL persistence for workflows, tasks, and node result revisions."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..paths import now_iso
from .errors import AppError

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflow_documents (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    origin TEXT NOT NULL,
    title TEXT NOT NULL,
    document_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    attempt INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    source_name TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    document_id TEXT,
    document_revision INTEGER,
    document_title TEXT,
    config_json TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    runtime_inputs_json TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    cover_path TEXT,
    message TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_node_results (
    task_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    parent_revision INTEGER,
    source TEXT NOT NULL,
    action_id TEXT,
    outputs_json TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, node_id, revision),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_actions (
    action_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    node_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
"""


class Database:
    """Thread-safe SQLite WAL repository initialized once data_dir is configured."""

    def __init__(self, db_path: Path | None = None) -> None:
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None
        self.db_path: Path | None = None
        if db_path is not None:
            self.open(db_path)

    @property
    def ready(self) -> bool:
        return self._conn is not None

    def open(self, db_path: Path) -> None:
        resolved = db_path.expanduser().resolve()
        with self._lock:
            if self._conn is not None and self.db_path == resolved:
                return
            if self._conn is not None:
                self._conn.close()
            resolved.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(resolved), check_same_thread=False, timeout=30.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.executescript(SCHEMA_SQL)
            conn.commit()
            self._conn = conn
            self.db_path = resolved

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
                self.db_path = None

    def _require_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise AppError(
                503,
                "SETUP_REQUIRED",
                "Select a workspace data folder before storing tasks or workflows.",
            )
        return self._conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._require_conn()
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    # ------------------------------------------------------------------
    # Workflow documents
    # ------------------------------------------------------------------

    def list_workflow_documents(self, *, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        with self.transaction() as conn:
            rows = conn.execute(
                "SELECT id, revision, origin, document_json, created_at, updated_at "
                "FROM workflow_documents ORDER BY CASE origin WHEN 'builtin' THEN 0 ELSE 1 END, updated_at DESC "
                "LIMIT ? OFFSET ?",
                (limit + 1, offset),
            ).fetchall()
        has_more = len(rows) > limit
        items = [
            {
                "id": row["id"],
                "revision": row["revision"],
                "origin": row["origin"],
                "document": json.loads(row["document_json"]),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows[:limit]
        ]
        return {"items": items, "hasMore": has_more, "limit": limit, "offset": offset}

    def get_workflow_document(self, doc_id: str) -> dict[str, Any]:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT id, revision, origin, document_json, created_at, updated_at "
                "FROM workflow_documents WHERE id = ?",
                (doc_id,),
            ).fetchone()
        if row is None:
            raise AppError(404, "WORKFLOW_NOT_FOUND", f"Workflow document {doc_id!r} does not exist.")
        return {
            "id": row["id"],
            "revision": row["revision"],
            "origin": row["origin"],
            "document": json.loads(row["document_json"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def upsert_workflow_document(
        self,
        document: dict[str, Any],
        *,
        origin: str = "user",
        expected_revision: int | None = None,
        create_only: bool = False,
    ) -> dict[str, Any]:
        doc_id = str(document["id"])
        title = str(document.get("title") or "")
        now = now_iso()
        serialized = json.dumps(document, ensure_ascii=False)
        with self.transaction() as conn:
            existing = conn.execute(
                "SELECT revision, origin, created_at FROM workflow_documents WHERE id = ?",
                (doc_id,),
            ).fetchone()
            if existing is None:
                if expected_revision is not None and expected_revision > 0:
                    raise AppError(404, "WORKFLOW_NOT_FOUND", f"Workflow document {doc_id!r} does not exist.")
                revision = 1
                conn.execute(
                    "INSERT INTO workflow_documents (id, revision, origin, title, document_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (doc_id, revision, origin, title, serialized, now, now),
                )
                created_at = now
            else:
                if create_only:
                    raise AppError(409, "CONFLICT", f"Workflow document {doc_id!r} already exists.")
                if expected_revision is not None and existing["revision"] != expected_revision:
                    raise AppError(
                        409,
                        "CONFLICT",
                        "Workflow document was updated elsewhere; reload before saving.",
                    )
                if existing["origin"] == "builtin" and origin == "user":
                    raise AppError(403, "BUILTIN_READONLY", "Built-in workflow templates cannot be overwritten.")
                revision = int(existing["revision"]) + 1
                conn.execute(
                    "UPDATE workflow_documents SET revision = ?, title = ?, document_json = ?, updated_at = ? "
                    "WHERE id = ?",
                    (revision, title, serialized, now, doc_id),
                )
                created_at = existing["created_at"]
        return {
            "id": doc_id,
            "revision": revision,
            "origin": origin if existing is None else existing["origin"],
            "document": document,
            "createdAt": created_at,
            "updatedAt": now,
        }

    def seed_builtin_template(self, document: dict[str, Any]) -> None:
        doc_id = str(document["id"])
        title = str(document.get("title") or "")
        now = now_iso()
        serialized = json.dumps(document, ensure_ascii=False)
        with self.transaction() as conn:
            existing = conn.execute(
                "SELECT origin FROM workflow_documents WHERE id = ?", (doc_id,)
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO workflow_documents (id, revision, origin, title, document_json, created_at, updated_at) "
                    "VALUES (?, 1, 'builtin', ?, ?, ?, ?)",
                    (doc_id, title, serialized, now, now),
                )
            elif existing["origin"] == "builtin":
                conn.execute(
                    "UPDATE workflow_documents SET title = ?, document_json = ?, updated_at = ? "
                    "WHERE id = ? AND origin = 'builtin'",
                    (title, serialized, now, doc_id),
                )

    def delete_workflow_document(self, doc_id: str, *, expected_revision: int | None = None) -> None:
        with self.transaction() as conn:
            existing = conn.execute(
                "SELECT revision, origin FROM workflow_documents WHERE id = ?",
                (doc_id,),
            ).fetchone()
            if existing is None:
                raise AppError(404, "WORKFLOW_NOT_FOUND", f"Workflow document {doc_id!r} does not exist.")
            if existing["origin"] == "builtin":
                raise AppError(403, "BUILTIN_READONLY", "Built-in workflow templates cannot be deleted.")
            if expected_revision is not None and existing["revision"] != expected_revision:
                raise AppError(409, "CONFLICT", "Workflow document revision does not match.")
            conn.execute("DELETE FROM workflow_documents WHERE id = ?", (doc_id,))

    # ------------------------------------------------------------------
    # Tasks & node revisions
    # ------------------------------------------------------------------

    @staticmethod
    def _allowed_actions(status: str) -> list[str]:
        if status in {"queued", "running", "waiting", "paused"}:
            return ["cancel"]
        if status == "cancelling":
            return []
        if status in {"failed", "cancelled"}:
            return ["retry", "rerun", "delete"]
        if status == "succeeded":
            return ["rerun", "delete"]
        return []

    def _row_to_task(self, row: sqlite3.Row, *, include_detail: bool = True) -> dict[str, Any]:
        task_id = row["id"]
        status = row["status"]
        base: dict[str, Any] = {
            "id": task_id,
            "attempt": row["attempt"],
            "revision": row["revision"],
            "status": status,
            "sourceName": row["source_name"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "workflowId": row["workflow_id"],
            "workflowVersion": row["workflow_version"],
            "steps": json.loads(row["steps_json"]),
            "outputs": json.loads(row["outputs_json"]),
            "allowedActions": self._allowed_actions(status),
            "message": row["message"],
            "error": json.loads(row["error_json"]) if row["error_json"] else None,
        }
        if row["cover_path"]:
            base["cover"] = {"url": f"/api/tasks/{task_id}/cover?v={row['revision']}"}
        if row["document_id"]:
            base["workflowSource"] = {
                "documentId": row["document_id"],
                "documentRevision": row["document_revision"],
                "title": row["document_title"] or "",
            }
        if include_detail:
            base["config"] = json.loads(row["config_json"])
            base["graphSnapshot"] = json.loads(row["graph_json"])
            base["nodeRuntimeInputs"] = json.loads(row["runtime_inputs_json"])
        return base

    def create_task(self, task: dict[str, Any]) -> dict[str, Any]:
        now = task.get("createdAt") or now_iso()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO tasks ("
                "id, attempt, revision, status, source_name, workflow_id, workflow_version, "
                "document_id, document_revision, document_title, config_json, graph_json, "
                "runtime_inputs_json, steps_json, outputs_json, cover_path, message, error_json, "
                "created_at, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    task["id"],
                    task.get("attempt", 1),
                    task.get("revision", 1),
                    task.get("status", "queued"),
                    task["sourceName"],
                    task["workflowId"],
                    task["workflowVersion"],
                    task.get("documentId"),
                    task.get("documentRevision"),
                    task.get("documentTitle"),
                    json.dumps(task.get("config", {}), ensure_ascii=False),
                    json.dumps(task["graphSnapshot"], ensure_ascii=False),
                    json.dumps(task.get("nodeRuntimeInputs", {}), ensure_ascii=False),
                    json.dumps(task.get("steps", []), ensure_ascii=False),
                    json.dumps(task.get("outputs", []), ensure_ascii=False),
                    task.get("coverPath"),
                    task.get("message"),
                    json.dumps(task["error"], ensure_ascii=False) if task.get("error") else None,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task["id"],)).fetchone()
        return self._row_to_task(row, include_detail=True)

    def get_task(self, task_id: str) -> dict[str, Any]:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise AppError(404, "TASK_NOT_FOUND", f"Task {task_id!r} does not exist.")
        return self._row_to_task(row, include_detail=True)

    def list_tasks(
        self,
        *,
        limit: int = 20,
        offset: int = 0,
        status: str | None = None,
    ) -> dict[str, Any]:
        params: list[Any] = []
        where = ""
        if status:
            where = "WHERE status = ?"
            params.append(status)
        params.extend([limit + 1, offset])
        with self.transaction() as conn:
            rows = conn.execute(
                f"SELECT * FROM tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        has_more = len(rows) > limit
        items = [self._row_to_task(row, include_detail=False) for row in rows[:limit]]
        return {"items": items, "hasMore": has_more, "limit": limit, "offset": offset}

    def update_task(
        self,
        task_id: str,
        *,
        status: str | None = None,
        attempt: int | None = None,
        source_name: str | None = None,
        steps: list[dict[str, Any]] | None = None,
        outputs: list[dict[str, Any]] | None = None,
        cover_path: str | None = None,
        message: str | None = ...,  # type: ignore[assignment]
        error: dict[str, Any] | None = ...,  # type: ignore[assignment]
        expected_attempt: int | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        now = now_iso()
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise AppError(404, "TASK_NOT_FOUND", f"Task {task_id!r} does not exist.")
            if expected_attempt is not None and row["attempt"] != expected_attempt:
                raise AppError(409, "CONFLICT", "Task attempt does not match.")
            if expected_revision is not None and row["revision"] != expected_revision:
                raise AppError(409, "CONFLICT", "Task revision does not match.")
            next_revision = int(row["revision"]) + 1
            conn.execute(
                "UPDATE tasks SET "
                "attempt = ?, revision = ?, status = ?, source_name = ?, steps_json = ?, outputs_json = ?, "
                "cover_path = ?, message = ?, error_json = ?, updated_at = ? "
                "WHERE id = ?",
                (
                    attempt if attempt is not None else row["attempt"],
                    next_revision,
                    status if status is not None else row["status"],
                    source_name if source_name is not None else row["source_name"],
                    json.dumps(steps, ensure_ascii=False) if steps is not None else row["steps_json"],
                    json.dumps(outputs, ensure_ascii=False) if outputs is not None else row["outputs_json"],
                    cover_path if cover_path is not None else row["cover_path"],
                    row["message"] if message is ... else message,
                    row["error_json"]
                    if error is ...
                    else (json.dumps(error, ensure_ascii=False) if error is not None else None),
                    now,
                    task_id,
                ),
            )
            updated = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._row_to_task(updated, include_detail=True)

    def delete_task(self, task_id: str, *, expected_attempt: int | None = None) -> None:
        with self.transaction() as conn:
            row = conn.execute("SELECT attempt, status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise AppError(404, "TASK_NOT_FOUND", f"Task {task_id!r} does not exist.")
            if row["status"] in {"queued", "running", "waiting", "cancelling"}:
                raise AppError(409, "TASK_ACTIVE", "Cancel an active task before deleting it.")
            if expected_attempt is not None and row["attempt"] != expected_attempt:
                raise AppError(409, "CONFLICT", "Task attempt does not match.")
            conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))

    def add_node_result(
        self,
        task_id: str,
        node_id: str,
        *,
        source: str,
        outputs: dict[str, Any],
        parent_revision: int | None = None,
        action_id: str | None = None,
        approved: bool = False,
    ) -> dict[str, Any]:
        now = now_iso()
        serialized = json.dumps(outputs, ensure_ascii=False)
        with self.transaction() as conn:
            max_row = conn.execute(
                "SELECT COALESCE(MAX(revision), 0) AS max_rev FROM task_node_results "
                "WHERE task_id = ? AND node_id = ?",
                (task_id, node_id),
            ).fetchone()
            next_rev = int(max_row["max_rev"]) + 1
            if approved:
                conn.execute(
                    "UPDATE task_node_results SET approved = 0 WHERE task_id = ? AND node_id = ?",
                    (task_id, node_id),
                )
            conn.execute(
                "INSERT INTO task_node_results "
                "(task_id, node_id, revision, parent_revision, source, action_id, outputs_json, approved, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    task_id,
                    node_id,
                    next_rev,
                    parent_revision,
                    source,
                    action_id,
                    serialized,
                    1 if approved else 0,
                    now,
                ),
            )
            if action_id:
                conn.execute(
                    "INSERT OR IGNORE INTO task_actions (action_id, task_id, node_id, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (action_id, task_id, node_id, now),
                )
        return {
            "revision": next_rev,
            "parentRevision": parent_revision,
            "source": source,
            "actionId": action_id,
            "outputs": outputs,
            "createdAt": now,
        }

    def mark_node_approved(
        self, task_id: str, node_id: str, revision: int, *, action_id: str | None = None
    ) -> None:
        now = now_iso()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE task_node_results SET approved = CASE WHEN revision = ? THEN 1 ELSE 0 END "
                "WHERE task_id = ? AND node_id = ?",
                (revision, task_id, node_id),
            )
            if action_id:
                conn.execute(
                    "INSERT OR IGNORE INTO task_actions (action_id, task_id, node_id, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (action_id, task_id, node_id, now),
                )

    def get_node_results(self, task_id: str, node_id: str) -> list[dict[str, Any]]:
        with self.transaction() as conn:
            rows = conn.execute(
                "SELECT revision, parent_revision, source, action_id, outputs_json, approved, created_at "
                "FROM task_node_results WHERE task_id = ? AND node_id = ? ORDER BY revision ASC",
                (task_id, node_id),
            ).fetchall()
        return [
            {
                "revision": row["revision"],
                "parentRevision": row["parent_revision"],
                "source": row["source"],
                "actionId": row["action_id"],
                "outputs": json.loads(row["outputs_json"]),
                "approved": bool(row["approved"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def get_action(self, task_id: str, action_id: str) -> dict[str, Any] | None:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT action_id, task_id, node_id, created_at FROM task_actions "
                "WHERE task_id = ? AND action_id = ?",
                (task_id, action_id),
            ).fetchone()
        return dict(row) if row is not None else None

    def mark_stale_tasks_failed(self) -> list[str]:
        """Recover uncleanly interrupted active tasks on startup so users can resume via retry."""
        now = now_iso()
        interrupted_ids: list[str] = []
        with self.transaction() as conn:
            rows = conn.execute(
                "SELECT id, revision, steps_json FROM tasks WHERE status IN ('queued', 'running', 'waiting', 'cancelling')"
            ).fetchall()
            for row in rows:
                steps = json.loads(row["steps_json"])
                for step in steps:
                    if step.get("status") in {"running", "waiting"}:
                        step["status"] = "failed"
                        step["error"] = {"message": "Interrupted by application restart."}
                conn.execute(
                    "UPDATE tasks SET status = 'failed', revision = ?, steps_json = ?, "
                    "message = 'Interrupted by application restart', "
                    "error_json = ?, updated_at = ? WHERE id = ?",
                    (
                        int(row["revision"]) + 1,
                        json.dumps(steps, ensure_ascii=False),
                        json.dumps({"code": "INTERRUPTED", "message": "Interrupted by application restart; click Continue to resume."}),
                        now,
                        row["id"],
                    ),
                )
                interrupted_ids.append(row["id"])
        return interrupted_ids
