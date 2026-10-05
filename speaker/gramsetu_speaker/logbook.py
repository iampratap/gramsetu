"""Captures the agent's log lines so admins can read them in GramSetu, live or later."""

from __future__ import annotations

import collections
import logging
import traceback
import uuid
from datetime import datetime, timezone

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


class LogBook(logging.Handler):
    """Buffers records in memory; the agent moves them to SQLite and on to the server."""

    def __init__(self, level: int = logging.INFO):
        super().__init__(level)
        # Logging may be called from any thread, so only touch a thread-safe deque here.
        self.buffer: collections.deque[dict] = collections.deque(maxlen=10_000)

    def emit(self, record: logging.LogRecord):
        try:
            message = record.getMessage()
            if record.exc_info:
                message += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
            self.buffer.append(
                {
                    "localId": uuid.uuid4().hex,
                    "level": record.levelname if record.levelname in LEVELS else "INFO",
                    "logger": record.name[:64],
                    "message": message[:8000],
                    "loggedAt": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
                }
            )
        except Exception:  # noqa: BLE001
            self.handleError(record)

    def drain(self) -> list[dict]:
        items = []
        while self.buffer:
            items.append(self.buffer.popleft())
        return items

    @property
    def level_name(self) -> str:
        return logging.getLevelName(self.level)

    def set_level_name(self, name: str):
        name = str(name).upper()
        if name not in LEVELS:
            raise ValueError(f"unknown log level {name}")
        self.setLevel(getattr(logging, name))


def install(level_name: str = "INFO") -> LogBook:
    book = LogBook()
    try:
        book.set_level_name(level_name)
    except ValueError:
        book.setLevel(logging.INFO)
    logging.getLogger().addHandler(book)
    return book
