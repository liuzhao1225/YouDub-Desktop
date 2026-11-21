"""Single-channel Server-Sent Events hub for real-time UI updates."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any


class EventHub:
    """Broadcasts typed JSON events to connected SSE clients."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        message = f"event: {event_type}\ndata: {json.dumps(payload or {}, ensure_ascii=False)}\n\n"
        loop = self._loop
        if loop is not None and loop.is_running():
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is not loop:
                loop.call_soon_threadsafe(self._enqueue_all, message)
                return
        self._enqueue_all(message)

    def _enqueue_all(self, message: str) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def subscribe(self) -> AsyncIterator[str]:
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
        self._subscribers.add(queue)
        try:
            yield f"event: connected\ndata: {json.dumps({'ok': True})}\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield item
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            self._subscribers.discard(queue)
