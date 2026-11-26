"""End-to-end FastAPI tests: setup, workflows, DAG review/correction, rerun, log tail, SSE, auth."""

from __future__ import annotations

import json
import time
import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from backend.app.server.api import create_app


def _make_client(tmp_path, *, auth_token: str = ""):
    app = create_app(config_dir=tmp_path / "cfg", auth_token=auth_token)
    return app, TestClient(app)


def test_setup_auth_and_seeded_workflows(tmp_path):
    app, client = _make_client(tmp_path, auth_token="secret-tok")
    with client:
        assert client.get("/api/health").json()["ok"] is True
        assert client.get("/api/settings").status_code == 401

        headers = {"Authorization": "Bearer secret-tok"}
        setup = client.get("/api/setup", headers=headers).json()
        assert setup["phase"] == "installation"

        workspace = tmp_path / "data"
        ready = client.post(
            "/api/setup",
            headers=headers,
            json={"action": "configure", "path": str(workspace)},
        ).json()
        assert ready["phase"] == "ready"

        node_types = client.get("/api/node-types", headers=headers).json()["items"]
        transcribe = next(n for n in node_types if n["type"] == "youdub.transcribe")
        assert transcribe["provider"]["models"][0]["id"] == "large-v3-turbo"

        docs = client.get("/api/workflow-documents", headers=headers).json()["items"]
        assert {d["id"] for d in docs} == {
            "youdub.subtitles", "youdub.dubbing", "youdub.subtitles-dubbing",
            "youdub.audio-subtitles", "youdub.audio-dubbing",
        }
        for doc in docs:
            validation = client.post(
                "/api/workflow-documents/validate", headers=headers, json={"document": doc["document"]},
            ).json()
            assert validation == {"valid": True, "diagnostics": []}, doc["id"]
        sub_doc = next(d["document"] for d in docs if d["id"] == "youdub.subtitles")
        assert next(n for n in sub_doc["nodes"] if n["id"] == "recognize")["provider"]["model"] == "large-v3-turbo"


def _use_audio_download(doc):
    doc["inputs"] = []
    doc["nodes"].insert(0, {
        "id": "download", "type": "youdub.downloadAudio", "typeVersion": "1.0.0",
        "provider": {"id": "youdub.download"}, "config": {}, "autoContinue": True,
    })
    for edge in doc["edges"]:
        if edge["source"] == {"nodeId": "$inputs", "portId": "audio"}:
            edge["source"]["nodeId"] = "download"


def test_audio_download_port_contracts(tmp_path):
    _, client = _make_client(tmp_path)
    with client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")})
        catalog = {n["type"]: n for n in client.get("/api/node-types").json()["items"]}
        for node_type, expected_outputs in (
            ("youdub.download", [("video", "video/mp4/v1"), ("cover", "image/jpeg/v1")]),
            ("youdub.downloadAudio", [("audio", "audio/file/v1")]),
        ):
            node = catalog[node_type]
            assert node["providerId"] == node["provider"]["id"] == "youdub.download"
            assert [(p["name"], p["schemaId"]) for p in node["outputs"]] == expected_outputs

        doc = client.get("/api/workflow-documents/youdub.audio-subtitles").json()["document"]
        _use_audio_download(doc)
        validate = "/api/workflow-documents/validate"
        assert client.post(validate, json={"document": doc}).json() == {"valid": True, "diagnostics": []}
        doc["edges"].append({
            "id": "invalid", "source": {"nodeId": "download", "portId": "audio"},
            "target": {"nodeId": "export", "portId": "video"},
        })
        result = client.post(validate, json={"document": doc}).json()
        assert result["valid"] is False
        assert [(d["edgeId"], d["code"]) for d in result["diagnostics"]] == [("invalid", "INCOMPATIBLE_PORTS")]


def test_workflow_validation_rejects_cycle(tmp_path):
    _, client = _make_client(tmp_path)
    with client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")})
        cyclic_doc = {
            "format": "youdub.workflow",
            "formatVersion": 1,
            "id": "cyclic",
            "title": "Cyclic",
            "nodes": [
                {"id": "s1", "type": "youdub.separate", "typeVersion": "1.0.0", "provider": {"id": "demucs", "model": "htdemucs"}, "config": {}, "autoContinue": True},
                {"id": "s2", "type": "youdub.separate", "typeVersion": "1.0.0", "provider": {"id": "demucs", "model": "htdemucs"}, "config": {}, "autoContinue": True},
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "s1", "portId": "vocals"}, "target": {"nodeId": "s2", "portId": "sourceAudio"}},
                {"id": "e2", "source": {"nodeId": "s2", "portId": "vocals"}, "target": {"nodeId": "s1", "portId": "sourceAudio"}},
            ],
            "inputs": [],
            "outputs": [],
            "presentation": {"positions": {}, "viewport": {"x": 0, "y": 0, "zoom": 1}},
        }
        resp = client.post("/api/workflow-documents/validate", json={"document": cyclic_doc}).json()
        assert resp["valid"] is False
        assert any(d["code"] == "CYCLE_DETECTED" for d in resp["diagnostics"])


def test_dag_pause_correction_approve_rerun_and_log_tail(monkeypatch, tmp_path):
    app, client = _make_client(tmp_path)
    with client:
        data_dir = tmp_path / "data"
        client.post("/api/setup", json={"action": "configure", "path": str(data_dir)})
        client.put(
            "/api/llm/providers/openai",
            json={
                "name": "DeepSeek",
                "protocol": "openai",
                "preset": "deepseek",
                "base_url": "https://api.deepseek.com/v1",
                "default_model": "deepseek-chat",
                "models": ["deepseek-chat"],
                "enabled": True,
                "api_key": "sk-test-key",
            },
        )

        # Mock heavy local subprocess and LLM translation for fast hermetic DAG verification
        async def fake_subprocess(task_id: str, node_id: str, spec: dict):
            wdir = Path(spec["workDir"])
            wdir.mkdir(parents=True, exist_ok=True)
            op = spec["operation"]
            if op == "media.prepare/v1":
                audio = wdir / "sourceAudio.wav"
                audio.write_bytes(b"RIFF0000")
                return {
                    "ok": True,
                    "artifacts": {"sourceAudio": str(audio)},
                    "outputs": {"mediaInfo": {"duration_ms": 2000, "width": 320, "height": 180, "frame_rate": 25}},
                }
            if op == "speech.transcribe/v1":
                return {
                    "ok": True,
                    "artifacts": {},
                    "outputs": {
                        "transcript": {
                            "detected_language": "en",
                            "segments": [{"id": "segment-000001", "start_ms": 0, "end_ms": 1500, "text": "Original text."}],
                        }
                    },
                }
            if op == "media.export/v1":
                out_dir = wdir / "export_out"
                out_dir.mkdir(parents=True, exist_ok=True)
                v = out_dir / "video.mp4"
                s1 = out_dir / "source.srt"
                s2 = out_dir / "translated.srt"
                v.write_bytes(b"mp4-bytes")
                s1.write_text("1\n00:00:00,000 --> 00:00:01,500\nFixed source\n", encoding="utf-8")
                s2.write_text("1\n00:00:00,000 --> 00:00:01,500\n你好世界\n", encoding="utf-8")
                return {"ok": True, "artifacts": {"video": str(v), "sourceSubtitles": str(s1), "translatedSubtitles": str(s2)}, "outputs": {}}
            raise AssertionError(f"Unexpected op: {op}")

        async def fake_translate(transcript, **_kwargs):
            return {
                "source_language": transcript["detected_language"],
                "target_language": "zh",
                "segments": [{"segment_id": s["id"], "text": "你好世界。"} for s in transcript["segments"]],
            }

        monkeypatch.setattr(app.state.runner, "_run_stage_subprocess", fake_subprocess)
        monkeypatch.setattr("backend.app.server.dag.translate_transcript", fake_translate)

        doc = client.get("/api/workflow-documents/youdub.subtitles").json()["document"]
        req_payload = {
            "id": "task-1",
            "workflowId": "youdub.graph",
            "workflowVersion": "1.0.0",
            "graphDocument": doc,
            "config": {},
        }
        created = client.post(
            "/api/tasks",
            data={"request": json.dumps(req_payload)},
            files={"input.video": ("sample.mp4", b"fake-mp4-data", "video/mp4")},
        )
        assert created.status_code == 200

        # Wait until DAG pauses at 'recognize' (autoContinue: false)
        task = {}
        for _ in range(40):
            task = client.get("/api/tasks/task-1").json()
            if task["status"] == "paused":
                break
            time.sleep(0.05)
        assert task["status"] == "paused"
        assert next(s for s in task["steps"] if s["id"] == "recognize")["status"] == "awaiting_review"

        # Save manual transcript correction & continue
        detail = client.get("/api/tasks/task-1/nodes/recognize").json()
        corrected_transcript = detail["resultRevisions"][-1]["outputs"]["transcript"]
        corrected_transcript["segments"][0]["text"] = "Fixed source."
        res_corr = client.post(
            "/api/tasks/task-1/nodes/recognize/corrections",
            json={
                "actionId": "act-1",
                "expectedAttempt": detail["attempt"],
                "expectedTaskRevision": detail["taskRevision"],
                "expectedOutputRevision": detail["outputRevision"],
                "patch": {"transcript": corrected_transcript},
                "continue": True,
            },
        )
        assert res_corr.status_code == 200

        # Next node 'translate' also has autoContinue=false -> wait for pause
        for _ in range(40):
            task = client.get("/api/tasks/task-1").json()
            if task["status"] == "paused" and next(s for s in task["steps"] if s["id"] == "translate")["status"] == "awaiting_review":
                break
            time.sleep(0.05)
        assert task["status"] == "paused"

        t_detail = client.get("/api/tasks/task-1/nodes/translate").json()
        res_app = client.post(
            "/api/tasks/task-1/nodes/translate/approve",
            json={
                "actionId": "act-2",
                "expectedAttempt": t_detail["attempt"],
                "expectedTaskRevision": t_detail["taskRevision"],
                "expectedOutputRevision": t_detail["outputRevision"],
            },
        )
        assert res_app.status_code == 200

        for _ in range(40):
            task = client.get("/api/tasks/task-1").json()
            if task["status"] == "succeeded":
                break
            time.sleep(0.05)
        assert task["status"] == "succeeded"
        assert len(task["outputs"]) == 3
        assert client.get("/api/tasks/task-1/files/translated-subtitles").text.strip().endswith("你好世界")

        # Verify tail vs full log endpoints
        tail = client.get("/api/tasks/task-1/log?lines=2")
        assert len(tail.text.splitlines()) <= 2
        assert tail.headers["X-Log-Truncated"] == "true"
        full = client.get("/api/tasks/task-1/log?full=true")
        assert full.headers["X-Log-Truncated"] == "false"
        assert "Workflow finished successfully." in full.text

        # Verify rerun-preview & derived task reuses unchanged prepare + recognize + translate
        preview = client.post(
            "/api/tasks/task-1/rerun-preview",
            json={"graphDocument": doc, "expectedAttempt": task["attempt"], "expectedTaskRevision": task["revision"]},
        ).json()
        assert set(preview["reusedSteps"]) == {"prepare", "recognize", "translate", "export"}
        assert preview["dirtySteps"] == []


def test_audio_download_worker(monkeypatch, tmp_path):
    from backend.app.server import stage_worker

    audio = tmp_path / "download.webm"
    metadata = {"title": "Interview"}
    download = Mock(return_value=(audio, metadata))
    monkeypatch.setattr(stage_worker, "download_audio", download)
    spec = {
        "operation": "audio.download/v1", "workDir": str(tmp_path), "url": "https://example.com/interview",
        "config": {"proxyPort": 8080}, "proxyUrl": "http://localhost:8080",
        "ffmpegLocation": "/bin/ffmpeg", "cookiefile": str(tmp_path / "cookies.txt"),
    }
    assert stage_worker.execute_spec(spec) == {"artifacts": {"audio": str(audio)}, "outputs": {"metadata": metadata}}
    download.assert_called_once_with(
        spec["url"], tmp_path, proxy_port=8080, proxy_url=spec["proxyUrl"], ffmpeg_location=spec["ffmpegLocation"],
        cookiefile=spec["cookiefile"], check_cancel=stage_worker._noop_cancel, progress=stage_worker._progress,
    )


def test_audio_export_worker_honors_requested_subtitle_files(monkeypatch, tmp_path):
    from backend.app.server import stage_worker
    from backend.app.v1.steps import Completed

    run = Mock(return_value=Completed(output_files={}))
    monkeypatch.setattr(stage_worker.export, "run", run)
    stage_worker.execute_spec({
        "operation": "media.export/v1", "workDir": str(tmp_path),
        "config": {"renderSubtitles": False}, "hasDubbing": True, "hasSubtitles": True,
        "inputFiles": {p: str(tmp_path / p) for p in ("mediaInfo", "transcript", "translation", "finalAudio", "dubbedTimeline")},
    })
    ctx = run.call_args.args[0]
    assert ctx.config.output_mode == "both"
    assert set(ctx.input_files) == {"media_info", "transcript", "translation", "mixed_audio", "alignment"}


@pytest.mark.parametrize("template_id", ["youdub.audio-subtitles", "youdub.audio-dubbing"])
def test_audio_workflow_task(monkeypatch, tmp_path, template_id):
    from backend.app.server import stage_worker

    app, client = _make_client(tmp_path)
    runner = app.state.runner
    cover = Mock()
    monkeypatch.setattr(runner, "_maybe_extract_cover", cover)

    duration_ms = 1000
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", ""))
        wav.writeframes(bytes(16000 * 2))
    wav_bytes = buffer.getvalue()
    source_url = "https://example.com/interview"
    is_download = template_id == "youdub.audio-subtitles"

    def download_audio(url, work_dir, **_kwargs):
        assert url == source_url
        path = work_dir / "interview.webm"
        path.write_bytes(b"downloaded audio")
        return path, {"title": "Interview"}

    monkeypatch.setattr(stage_worker, "download_audio", download_audio)
    segment = {"id": "one", "start_ms": 0, "end_ms": duration_ms, "text": "Hello"}

    async def translate(transcript, **_kwargs):
        assert transcript["segments"] == [segment]
        return {"source_language": "en", "target_language": "zh", "segments": [{"segment_id": "one", "text": "你好"}]}

    monkeypatch.setattr("backend.app.server.dag.translate_transcript", translate)

    async def run_stage(task_id, node_id, spec):
        inputs = spec["inputFiles"]
        op = spec["operation"]
        if op in {"audio.download/v1", "media.export/v1"}:
            return stage_worker.execute_spec(spec)
        if op == "media.prepare/v1":
            source = Path(inputs["video"])
            assert source.read_bytes() == (b"downloaded audio" if is_download else wav_bytes)
            prepared = Path(spec["workDir"]) / "source.wav"
            prepared.write_bytes(wav_bytes)
            return {"artifacts": {"sourceAudio": str(prepared)}, "outputs": {"mediaInfo": {"duration_ms": duration_ms}}}
        if op == "audio.separate/v1":
            return {"artifacts": {"vocals": inputs["sourceAudio"], "background": inputs["sourceAudio"]}}
        if op == "speech.transcribe/v1":
            return {"outputs": {"transcript": {"detected_language": "en", "segments": [segment]}}}
        if op == "speech.reference/v1":
            return {"outputs": {"references": {}}}
        if op == "speech.synthesize/v1":
            return {"outputs": {"speechAudio": {"segments": []}}}
        if op == "audio.mix/v1":
            timeline = {"segments": [{
                "segment_id": "one", "source_start_ms": 0, "source_end_ms": duration_ms,
                "dubbed_start_ms": 0, "dubbed_end_ms": duration_ms,
            }]}
            return {"artifacts": {"finalAudio": inputs["background"]}, "outputs": {"dubbedTimeline": timeline}}
        raise AssertionError(f"Unexpected stage {op}")

    monkeypatch.setattr(runner, "_run_stage_subprocess", run_stage)
    with client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")})
        doc = client.get(f"/api/workflow-documents/{template_id}").json()["document"]
        payload = {"graphDocument": doc}
        if is_download:
            _use_audio_download(doc)
            for node in doc["nodes"]:
                node["autoContinue"] = True
            payload.update(sourceName=source_url, nodeRuntimeInputs={"download": {"url": source_url}})
            created = client.post("/api/tasks", json=payload)
        else:
            created = client.post("/api/tasks", data={"request": json.dumps(payload)},
                                  files={"input.audio": ("interview.wav", wav_bytes, "audio/wav")})
        assert created.status_code == 200, created.text
        task_id = created.json()["id"]
        task_url = f"/api/tasks/{task_id}"
        deadline = time.monotonic() + 5
        while True:
            task = client.get(task_url).json()
            if task["status"] not in {"queued", "running"} or time.monotonic() >= deadline:
                break
            time.sleep(0.05)
        assert task["status"] == "succeeded", task
        cover.assert_not_called()
        export_dir = runner.task_dir(task_id) / "nodes" / "export" / "export_out"
        output_ids = {out["id"] for out in task["outputs"]}
        if is_download:
            assert task["sourceName"] == "Interview"
            path, artifact = runner.resolve_artifact_path(task_id, "download:audio")
            assert path.suffix == ".webm"
            assert artifact["schemaId"] == "audio/file/v1"
            assert output_ids == {"source-subtitles", "translated-subtitles"}
            assert {p.name for p in export_dir.iterdir()} == {"source.srt", "translated.srt"}
            assert "Hello" in client.get(f"{task_url}/files/source-subtitles").text
            assert "你好" in client.get(f"{task_url}/files/translated-subtitles").text
        else:
            assert output_ids == {"audio"}
            assert {p.name for p in export_dir.iterdir()} == {"audio.wav"}
            assert client.get(f"{task_url}/files/audio").content == wav_bytes


def test_stage_worker_export_port_mapping_keep_bg_false_and_japanese_alignment(monkeypatch, tmp_path):
    from backend.app.server.stage_worker import _base_task_config, execute_spec
    from backend.app.v1.steps import Completed

    # 1. hasDubbing=True + keepBackground=False must validate cleanly without raising ValueError
    mix_cfg = _base_task_config(
        {
            "operation": "audio.mix/v1",
            "config": {"keepBackground": False, "targetLanguage": "ja"},
            "provider": {"id": "youdub.media"},
            "hasDubbing": True,
            "hasSubtitles": True,
        }
    )
    assert mix_cfg.keep_background is False
    assert mix_cfg.separation is not None
    assert mix_cfg.subtitle_alignment is None

    # 2. subtitles.align/v1 with targetLanguage="ja" aligns cues onto dubbed timeline without Qwen3
    work_align = tmp_path / "align"
    work_align.mkdir()
    tr_path = work_align / "transcript.json"
    tl_path = work_align / "translation.json"
    dt_path = work_align / "dubbedTimeline.json"
    tr_path.write_text(
        json.dumps(
            {
                "detected_language": "en",
                "segments": [{"id": "segment-000001", "start_ms": 0, "end_ms": 2000, "text": "Hello world."}],
            }
        ),
        encoding="utf-8",
    )
    tl_path.write_text(
        json.dumps(
            {
                "source_language": "en",
                "target_language": "ja",
                "segments": [{"segment_id": "segment-000001", "text": "こんにちは、世界。"}],
            }
        ),
        encoding="utf-8",
    )
    dt_path.write_text(
        json.dumps(
            {
                "segments": [
                    {
                        "segment_id": "segment-000001",
                        "source_start_ms": 0,
                        "source_end_ms": 2000,
                        "dubbed_start_ms": 100,
                        "dubbed_end_ms": 1900,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    aligned_out = execute_spec(
        {
            "operation": "subtitles.align/v1",
            "workDir": str(work_align),
            "config": {"targetLanguage": "ja"},
            "provider": {"id": "qwen_forced_aligner", "model": "Qwen3-ForcedAligner-0.6B-hf", "device": "cpu"},
            "inputFiles": {
                "transcript": str(tr_path),
                "translation": str(tl_path),
                "dubbedTimeline": str(dt_path),
            },
            "hasDubbing": True,
            "hasSubtitles": True,
        }
    )
    cues = aligned_out["outputs"]["alignedSubtitles"]["cues"]
    assert len(cues) >= 1
    assert cues[0]["start_ms"] == 100
    assert cues[-1]["end_ms"] == 1900

    # 3. media.export/v1 maps snake_case output_files to workflow camelCase port IDs
    work_exp = tmp_path / "export"
    work_exp.mkdir()
    vid = work_exp / "in.mp4"
    aud = work_exp / "mixed.wav"
    mi = work_exp / "media.json"
    vid.write_bytes(b"mp4")
    aud.write_bytes(b"wav")
    mi.write_text(json.dumps({"duration_ms": 2000, "width": 320, "height": 180}), encoding="utf-8")

    def fake_export_run(_ctx, _progress, *, output_dir: Path, prepared_cues=None):
        output_dir.mkdir(parents=True, exist_ok=True)
        f_vid = output_dir / "video.mp4"
        f_aud = output_dir / "audio.wav"
        f_src = output_dir / "source.srt"
        f_tgt = output_dir / "translated.srt"
        for p in (f_vid, f_aud, f_src, f_tgt):
            p.write_text("ok", encoding="utf-8")
        return Completed(
            output_files={
                "video": f_vid,
                "audio": f_aud,
                "source_subtitles": f_src,
                "translated_subtitles": f_tgt,
            }
        )

    monkeypatch.setattr("backend.app.server.stage_worker.export.run", fake_export_run)
    exp_out = execute_spec(
        {
            "operation": "media.export/v1",
            "workDir": str(work_exp),
            "config": {"targetLanguage": "ja", "renderSubtitles": True},
            "provider": {"id": "youdub.media"},
            "inputFiles": {
                "video": str(vid),
                "mediaInfo": str(mi),
                "transcript": str(tr_path),
                "translation": str(tl_path),
                "finalAudio": str(aud),
                "dubbedTimeline": str(dt_path),
            },
            "hasDubbing": True,
            "hasSubtitles": True,
        }
    )
    assert set(exp_out["artifacts"].keys()) == {"video", "audio", "sourceSubtitles", "translatedSubtitles"}

    # 4. Validate Japanese both_doc and check_document skipping Qwen3 requirement for targetLanguage="ja"
    app, client = _make_client(tmp_path)
    with client:
        client.post("/api/setup", json={"action": "configure", "path": str(tmp_path / "data")})
        both_doc = client.get("/api/workflow-documents/youdub.subtitles-dubbing").json()["document"]
        for n in both_doc["nodes"]:
            if "targetLanguage" in n.get("config", {}):
                n["config"]["targetLanguage"] = "ja"
        valid_res = client.post("/api/workflow-documents/validate", json={"document": both_doc}).json()
        assert valid_res["valid"] is True
        check_res = client.post("/api/resources/check", json={"document": both_doc}).json()
        assert all(m["id"] != "qwen" for m in check_res["models"])


def test_system_active_work_counts_all_active_tasks_and_prep(tmp_path):
    app, client = _make_client(tmp_path, auth_token="tok")
    with client:
        assert client.get("/api/system/active-work").status_code == 401
        headers = {"Authorization": "Bearer tok"}
        assert client.get("/api/system/active-work", headers=headers).json() == {
            "activeTasks": 0,
            "preparingResources": False,
        }

        client.post("/api/setup", headers=headers, json={"action": "configure", "path": str(tmp_path / "data")})
        for idx in range(25):
            app.state.db.create_task(
                {
                    "id": f"task-{idx}",
                    "status": "succeeded" if idx < 21 else ("queued", "running", "waiting", "cancelling")[idx - 21],
                    "sourceName": "clip.mp4",
                    "workflowId": "wf",
                    "workflowVersion": "1.0",
                    "graphSnapshot": {"nodes": [], "edges": []},
                }
            )
        assert client.get("/api/system/active-work", headers=headers).json() == {
            "activeTasks": 4,
            "preparingResources": False,
        }

        app.state.resources._state.status = "preparing"
        assert client.get("/api/system/active-work", headers=headers).json()["preparingResources"] is True
