"""Local SQLite storage so the speaker keeps working without the server."""

from __future__ import annotations

import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS occurrences (key TEXT PRIMARY KEY, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  local_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_synced ON reports (synced, created_at);
CREATE TABLE IF NOT EXISTS audio_holds (audio_id TEXT PRIMARY KEY, keep_until REAL NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        self.db.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    def replace_schedules(self, schedules: list[dict]):
        with self.db:
            self.db.execute("BEGIN")
            self.db.execute("DELETE FROM schedules")
            self.db.executemany(
                "INSERT INTO schedules (id, body) VALUES (?, ?)",
                [(item["id"], json.dumps(item)) for item in schedules],
            )

    def schedules(self) -> list[dict]:
        return [json.loads(row[0]) for row in self.db.execute("SELECT body FROM schedules")]

    # How long to keep a cached file whose schedule is no longer on the server.

    def hold_audio(self, audio_id: str, keep_until: float, reason: str):
        self.db.execute(
            "INSERT INTO audio_holds (audio_id, keep_until, reason) VALUES (?, ?, ?) "
            "ON CONFLICT(audio_id) DO UPDATE SET reason = CASE WHEN excluded.keep_until > keep_until "
            "THEN excluded.reason ELSE reason END, keep_until = MAX(keep_until, excluded.keep_until)",
            (audio_id, keep_until, reason),
        )

    def audio_holds(self) -> dict[str, tuple[float, str]]:
        return {row[0]: (row[1], row[2]) for row in self.db.execute("SELECT audio_id, keep_until, reason FROM audio_holds")}

    def release_audio(self, audio_id: str):
        self.db.execute("DELETE FROM audio_holds WHERE audio_id = ?", (audio_id,))

    def add_delivery(self, delivery: dict) -> bool:
        cursor = self.db.execute(
            "INSERT OR IGNORE INTO deliveries (id, body, created_at) VALUES (?, ?, ?)",
            (delivery["id"], json.dumps(delivery), time.time()),
        )
        return cursor.rowcount > 0

    def pending_deliveries(self) -> list[dict]:
        rows = self.db.execute("SELECT body FROM deliveries WHERE status = 'pending' ORDER BY created_at")
        return [json.loads(row[0]) for row in rows]

    def finish_delivery(self, delivery_id: str):
        self.db.execute("UPDATE deliveries SET status = 'done' WHERE id = ?", (delivery_id,))

    def drop_pending_deliveries(self, keep_ids: set[str]):
        for delivery in self.pending_deliveries():
            if delivery["id"] not in keep_ids:
                self.db.execute("DELETE FROM deliveries WHERE id = ?", (delivery["id"],))

    def occurrence_done(self, key: str) -> bool:
        return self.db.execute("SELECT 1 FROM occurrences WHERE key = ?", (key,)).fetchone() is not None

    def mark_occurrence(self, key: str):
        self.db.execute("INSERT OR IGNORE INTO occurrences (key, created_at) VALUES (?, ?)", (key, time.time()))

    def add_report(self, report: dict):
        self.db.execute(
            "INSERT OR REPLACE INTO reports (local_id, body, synced, created_at) VALUES (?, ?, 0, ?)",
            (report["localId"], json.dumps(report), time.time()),
        )

    def unsynced_reports(self, limit: int = 100) -> list[dict]:
        rows = self.db.execute(
            "SELECT body FROM reports WHERE synced = 0 ORDER BY created_at LIMIT ?", (limit,)
        )
        return [json.loads(row[0]) for row in rows]

    def mark_reports_synced(self, local_ids: list[str]):
        self.db.executemany("UPDATE reports SET synced = 1 WHERE local_id = ?", [(item,) for item in local_ids])

    def unsynced_count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM reports WHERE synced = 0").fetchone()[0]

    # Log lines stay here only until the server confirms it has them.

    def add_logs(self, entries: list[dict]):
        with self.db:
            self.db.execute("BEGIN")
            self.db.executemany(
                "INSERT OR IGNORE INTO logs (local_id, body) VALUES (?, ?)",
                [(entry["localId"], json.dumps(entry)) for entry in entries],
            )

    def unsent_logs(self, limit: int = 200, max_bytes: int = 256 * 1024) -> list[dict]:
        batch, size = [], 0
        for (body,) in self.db.execute("SELECT body FROM logs ORDER BY seq LIMIT ?", (limit,)):
            size += len(body)
            if batch and size > max_bytes:
                break
            batch.append(json.loads(body))
        return batch

    def drop_logs(self, local_ids: list[str]):
        self.db.executemany("DELETE FROM logs WHERE local_id = ?", [(item,) for item in local_ids])

    def log_count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM logs").fetchone()[0]

    def trim_logs(self, max_rows: int = 50_000):
        """Drop the oldest unsent lines if the speaker has been offline for a very long time."""
        self.db.execute(
            "DELETE FROM logs WHERE seq <= (SELECT seq FROM logs ORDER BY seq DESC LIMIT 1 OFFSET ?)",
            (max_rows,),
        )

    def prune(self, keep_days: int = 30):
        cutoff = time.time() - keep_days * 86400
        self.db.execute("DELETE FROM reports WHERE synced = 1 AND created_at < ?", (cutoff,))
        self.db.execute("DELETE FROM occurrences WHERE created_at < ?", (time.time() - 3 * 86400,))
        self.db.execute("DELETE FROM deliveries WHERE status = 'done' AND created_at < ?", (cutoff,))
        self.trim_logs()
