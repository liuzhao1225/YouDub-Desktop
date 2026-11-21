"""Sentence-level Whisper resegmentation (#196) and SRT subtitle import."""

from __future__ import annotations

import re
from typing import Any

import sentencex

from .errors import AppError

_SRT_TIMESTAMP_RE = re.compile(
    r"^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})(?:\s.*)?$"
)


def _normalize_sentencex_lang(language: str | None) -> str:
    if not language:
        return "en"
    code = language.strip().lower().replace("_", "-")
    primary = code.split("-", 1)[0]
    if primary in {"zh", "ja", "en", "ko", "fr", "de", "es", "it", "pt", "ru"}:
        return primary
    return "en"


def _strip_ws(text: str) -> str:
    return "".join(text.split())


def resegment_whisper(raw_text: str, transcript: dict[str, Any]) -> dict[str, Any]:
    """Re-group Whisper word timestamps into sentencex sentences (#196).

    Invariants preserved:
    - No timed word is ever split across sentence boundaries.
    - Zero-duration buckets (start_ms == end_ms) are merged into their nearest neighbor.
    - Segment intervals remain strictly positive (end_ms > start_ms) and non-overlapping.
    - When timed words are unavailable or empty, the original transcript is returned intact.
    """
    segments = transcript.get("segments")
    if not isinstance(segments, list) or not segments or not raw_text or not raw_text.strip():
        return transcript

    all_words: list[dict[str, Any]] = []
    for seg in segments:
        words = seg.get("words") if isinstance(seg, dict) else None
        if not isinstance(words, list) or not words:
            return transcript
        speaker_id = seg.get("speaker_id")
        for word in words:
            text = word.get("text")
            start_ms = word.get("start_ms")
            end_ms = word.get("end_ms")
            if not isinstance(text, str) or type(start_ms) is not int or type(end_ms) is not int:
                return transcript
            compact = _strip_ws(text)
            if not compact:
                if all_words:
                    all_words[-1] = {
                        **all_words[-1],
                        "text": all_words[-1]["text"] + text,
                    }
                continue
            all_words.append(
                {
                    "text": text,
                    "compact": compact,
                    "start_ms": max(0, start_ms),
                    "end_ms": max(start_ms, end_ms),
                    "speaker_id": speaker_id,
                }
            )

    if not all_words:
        return transcript

    words_compact = "".join(word["compact"] for word in all_words)
    raw_compact = _strip_ws(raw_text)
    if words_compact != raw_compact:
        # Whisper sometimes normalizes punctuation between segment.text and words;
        # avoid corrupting timestamps when the non-whitespace character streams diverge.
        return transcript

    lang = _normalize_sentencex_lang(transcript.get("detected_language"))
    sentences = [item for item in sentencex.segment(lang, raw_text) if _strip_ws(item)]
    if len(sentences) <= 1:
        return transcript

    # Compute cumulative non-whitespace char bounds per word and per sentence.
    word_ends: list[int] = []
    cursor = 0
    for word in all_words:
        cursor += len(word["compact"])
        word_ends.append(cursor)

    buckets: list[list[dict[str, Any]]] = []
    word_idx = 0
    target_chars = 0
    for sentence in sentences:
        target_chars += len(_strip_ws(sentence))
        bucket: list[dict[str, Any]] = []
        while word_idx < len(all_words):
            word = all_words[word_idx]
            word_end = word_ends[word_idx]
            bucket.append(word)
            word_idx += 1
            if word_end >= target_chars:
                break
        if bucket:
            buckets.append(bucket)

    while word_idx < len(all_words):
        if buckets:
            buckets[-1].append(all_words[word_idx])
        else:
            buckets.append([all_words[word_idx]])
        word_idx += 1

    if not buckets:
        return transcript

    # Materialize timing bounds for each bucket and merge zero-duration segments
    # into their nearest temporal neighbor.
    def _bounds(bucket: list[dict[str, Any]]) -> tuple[int, int]:
        return min(w["start_ms"] for w in bucket), max(w["end_ms"] for w in bucket)

    i = 0
    while i < len(buckets) and len(buckets) > 1:
        start_ms, end_ms = _bounds(buckets[i])
        if end_ms <= start_ms:
            if i == 0:
                buckets[1] = buckets[0] + buckets[1]
                buckets.pop(0)
                continue
            if i == len(buckets) - 1:
                buckets[i - 1] = buckets[i - 1] + buckets[i]
                buckets.pop(i)
                i -= 1
                continue
            _, prev_end = _bounds(buckets[i - 1])
            next_start, _ = _bounds(buckets[i + 1])
            gap_before = abs(start_ms - prev_end)
            gap_after = abs(next_start - end_ms)
            if gap_before <= gap_after:
                buckets[i - 1] = buckets[i - 1] + buckets[i]
                buckets.pop(i)
                i -= 1
            else:
                buckets[i + 1] = buckets[i] + buckets[i + 1]
                buckets.pop(i)
            continue
        i += 1

    rebuilt: list[dict[str, Any]] = []
    prev_end = 0
    for index, bucket in enumerate(buckets, start=1):
        start_ms = max(prev_end, min(w["start_ms"] for w in bucket))
        end_ms = max(start_ms, max(w["end_ms"] for w in bucket))
        if end_ms <= start_ms:
            end_ms = start_ms + 1
        prev_end = end_ms

        speakers = [w["speaker_id"] for w in bucket if w.get("speaker_id")]
        seg_out: dict[str, Any] = {
            "id": f"segment-{index:06d}",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": "".join(w["text"] for w in bucket),
            "words": [
                {
                    "text": w["text"],
                    "start_ms": w["start_ms"],
                    "end_ms": max(w["start_ms"], w["end_ms"]),
                }
                for w in bucket
            ],
        }
        if speakers:
            seg_out["speaker_id"] = speakers[0]
        rebuilt.append(seg_out)

    return {
        "detected_language": transcript["detected_language"],
        "segments": rebuilt,
    }


def _parse_srt_ms(hours: str, minutes: str, seconds: str, millis: str) -> int:
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)


def parse_srt_transcript(content: str, *, language: str = "en") -> dict[str, Any]:
    """Parse an SRT subtitle file into a canonical Transcript JSON object."""
    blocks = re.split(r"\r?\n\s*\r?\n", content.strip().lstrip("\ufeff"))
    segments: list[dict[str, Any]] = []
    for block in blocks:
        lines = [line for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        timing_idx = 1 if (lines[0].strip().isdigit() and len(lines) > 1) else 0
        match = _SRT_TIMESTAMP_RE.match(lines[timing_idx].strip())
        if match is None or timing_idx + 1 >= len(lines):
            raise AppError(422, "INVALID_SUBTITLES", f"Invalid SRT block near: {lines[0][:60]}")
        start_ms = _parse_srt_ms(*match.groups()[:4])
        end_ms = _parse_srt_ms(*match.groups()[4:])
        text = " ".join(line.strip() for line in lines[timing_idx + 1 :]).strip()
        if not text:
            raise AppError(422, "INVALID_SUBTITLES", "SRT cue contains empty text.")
        if end_ms <= start_ms:
            raise AppError(422, "INVALID_SUBTITLES", f"SRT cue has non-positive duration ({start_ms} -> {end_ms}).")
        segments.append(
            {
                "id": f"segment-{len(segments) + 1:06d}",
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text,
            }
        )
    if not segments:
        raise AppError(422, "INVALID_SUBTITLES", "The uploaded SRT file contains no valid subtitle cues.")
    return {"detected_language": language, "segments": segments}
