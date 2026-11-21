"""Tests for #196 SentenceX Whisper word-aligned resegmentation and SRT import."""

from __future__ import annotations

import json
from pathlib import Path

from backend.app.server.whisper_resegment import parse_srt_transcript, resegment_whisper
from backend.app.v1 import asr
from backend.app.v1.segments import Transcript


def test_resegment_whisper_splits_english_into_sentences_and_preserves_word_contract():
    raw = {
        "text": " Hello Dr. Smith! How are you doing today? Everything works.",
        "language": "en",
        "segments": [
            {
                "start": 0.0,
                "end": 4.2,
                "text": " Hello Dr. Smith! How are you doing today? Everything works.",
                "speaker_id": "spk-1",
                "words": [
                    {"start": 0.0, "end": 0.4, "word": " Hello"},
                    {"start": 0.45, "end": 0.7, "word": " Dr."},
                    {"start": 0.75, "end": 1.1, "word": " Smith!"},
                    {"start": 1.4, "end": 1.6, "word": " How"},
                    {"start": 1.6, "end": 1.8, "word": " are"},
                    {"start": 1.8, "end": 2.0, "word": " you"},
                    {"start": 2.0, "end": 2.4, "word": " doing"},
                    {"start": 2.4, "end": 2.9, "word": " today?"},
                    {"start": 3.2, "end": 3.7, "word": " Everything"},
                    {"start": 3.7, "end": 4.2, "word": " works."},
                ],
            }
        ],
    }
    normalized = asr.normalize_result(raw)
    resegmented = resegment_whisper(raw["text"], normalized)
    validated = Transcript.model_validate(resegmented)
    assert [s.text.strip() for s in validated.segments] == [
        "Hello Dr. Smith!",
        "How are you doing today?",
        "Everything works.",
    ]
    assert validated.segments[0].start_ms == 0
    assert validated.segments[0].end_ms == 1100
    assert validated.segments[1].start_ms == 1400
    assert validated.segments[2].end_ms == 4200
    assert all(s.speaker_id == "spk-1" for s in validated.segments)


def test_resegment_merges_zero_duration_sentence_into_nearest_neighbor():
    raw = {
        "text": " First sentence. Wait. Second sentence.",
        "language": "en",
        "segments": [
            {
                "start": 0.0,
                "end": 5.0,
                "text": " First sentence. Wait. Second sentence.",
                "words": [
                    {"start": 0.0, "end": 0.5, "word": " First"},
                    {"start": 0.5, "end": 1.0, "word": " sentence."},
                    {"start": 1.2, "end": 1.2, "word": " Wait."},  # zero duration closer to First
                    {"start": 3.5, "end": 4.2, "word": " Second"},
                    {"start": 4.2, "end": 5.0, "word": " sentence."},
                ],
            }
        ],
    }
    normalized = asr.normalize_result(raw)
    resegmented = resegment_whisper(raw["text"], normalized)
    validated = Transcript.model_validate(resegmented)
    assert len(validated.segments) == 2
    assert validated.segments[0].text.strip() == "First sentence. Wait."


def test_resegment_real_issue_184_fixtures():
    fixtures_dir = Path(__file__).resolve().parents[1] / "fixtures"
    for name in ("asr_issue_184.json", "asr_issue_184_english.json"):
        raw = json.loads((fixtures_dir / name).read_text(encoding="utf-8"))
        normalized = asr.normalize_result(raw)
        raw_text = raw.get("text") or "".join(s["text"] for s in raw["segments"])
        resegmented = resegment_whisper(raw_text, normalized)
        validated = Transcript.model_validate(resegmented)
        assert len(validated.segments) >= 1
        assert all(seg.end_ms > seg.start_ms for seg in validated.segments)


def test_parse_srt_transcript():
    srt = (
        "1\n"
        "00:00:00,500 --> 00:00:02,000\n"
        "Hello world\n\n"
        "2\n"
        "00:00:02,250 --> 00:00:04,500\n"
        "Second line\n"
    )
    transcript = parse_srt_transcript(srt, language="en")
    validated = Transcript.model_validate(transcript)
    assert len(validated.segments) == 2
    assert validated.segments[0].start_ms == 500
    assert validated.segments[1].end_ms == 4500
