from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import random
import shutil
import socket
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

import aiohttp

from . import VERSION
from . import schedule as scheduling
from .broadcast import LiveStream
from .config import Config
from .logbook import LogBook
from .player import MpvPlayer, PlayerError
from .store import Store

log = logging.getLogger("agent")

# Lower plays first. A live test interrupts anything else and the
# interrupted item is played again afterwards.
PRIORITY = {"LIVE_TEST": 0, "ANNOUNCEMENT": 1, "SCHEDULE": 2}

JOURNAL_ARGS = {
    "agent": ["-u", "gramsetu-speaker"],
    "system": [],
    "kernel": ["-k"],
    "boot": ["-b"],
}
DIAGNOSTICS = [
    ("Uptime", ["uptime"]),
    ("OS", ["sh", "-c", "cat /etc/os-release | head -4; uname -a"]),
    ("Temperature and throttling", ["sh", "-c", "vcgencmd measure_temp; vcgencmd get_throttled"]),
    ("Memory", ["free", "-m"]),
    ("Disk", ["df", "-h", "/", "/var/lib/gramsetu-speaker"]),
    ("Network", ["sh", "-c", "ip -brief address; ip route | head -5"]),
    ("Clock", ["timedatectl"]),
    ("Audio devices", ["aplay", "-l"]),
    ("Services", ["systemctl", "--no-pager", "--failed"]),
]
MAX_JOURNAL_BYTES = 600 * 1024


class CommandError(Exception):
    pass


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
    except OSError:
        return None


@dataclass
class Item:
    source: str
    title: str
    audio: dict
    schedule_id: str | None = None
    delivery_id: str | None = None
    broadcast_id: str | None = None
    scheduled_for: datetime | None = None
    local_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    seq: int = 0
    started_at: datetime | None = None
    entry_id: int | None = None
    offline: bool = False
    end_result: str | None = None
    end_error: str | None = None
    requeue: bool = False

    def brief(self) -> dict:
        return {"title": self.title, "source": self.source, "scheduleId": self.schedule_id}


class Agent:
    def __init__(self, config: Config, logbook: LogBook):
        self.config = config
        self.logbook = logbook
        self.cache_dir = os.path.join(config.data_dir, "audio")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.store = Store(os.path.join(config.data_dir, "speaker.db"))
        saved_level = self.store.get("log_level")
        if saved_level:
            try:
                self.logbook.set_level_name(saved_level)
            except ValueError:
                pass
        self.logs_acked = asyncio.Event()
        self.volume = int(self.store.get("volume", config.default_volume))
        self.player = MpvPlayer(
            config.mpv_path,
            os.path.join(config.data_dir, "mpv.sock"),
            config.audio_device,
            self.volume,
            on_end=self._on_player_end,
            on_crash=self._on_player_crash,
        )
        self.queue: list[Item] = []
        self.current: Item | None = None
        self.live: LiveStream | None = None
        self.paused = False
        self.queued_deliveries: set[str] = set()
        self._seq = itertools.count(1)
        self._front = itertools.count(-1, -1)
        self.lock = asyncio.Lock()
        self.sync_lock = asyncio.Lock()
        self.download_locks: dict[str, asyncio.Lock] = {}
        self.sync_now = asyncio.Event()
        self.flush_now = asyncio.Event()
        self.state_now = asyncio.Event()
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.session: aiohttp.ClientSession | None = None
        self.started = time.monotonic()
        self.clock_skew: float | None = None
        self.last_error: str | None = None

    @property
    def online(self) -> bool:
        return self.ws is not None and not self.ws.closed

    async def run(self):
        timeout = aiohttp.ClientTimeout(total=None, connect=15, sock_read=60)
        self.session = aiohttp.ClientSession(headers=self.config.auth_headers, timeout=timeout)
        await self.player.start()
        tasks = [
            asyncio.create_task(self.player.supervise()),
            asyncio.create_task(self._connection_loop()),
            asyncio.create_task(self._sync_loop()),
            asyncio.create_task(self._schedule_loop()),
            asyncio.create_task(self._report_loop()),
            asyncio.create_task(self._state_loop()),
            asyncio.create_task(self._log_loop()),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            if self.current:
                self._record(self.current, "STOPPED", "Speaker agent stopped")
            log.info("agent stopping")
            self._persist_logs()
            await self.player.shutdown()
            await self.session.close()

    # ---- server connection -------------------------------------------------

    async def _connection_loop(self):
        backoff = 2
        while True:
            try:
                async with self.session.ws_connect(self.config.ws_url, heartbeat=25, max_msg_size=1024 * 1024) as ws:
                    self.ws = ws
                    backoff = 2
                    log.info("connected to %s", self.config.server_url)
                    await self._send({"type": "hello", "agentVersion": VERSION, "localIp": local_ip()})
                    self.sync_now.set()
                    self.flush_now.set()
                    self.state_now.set()
                    async for message in ws:
                        if message.type == aiohttp.WSMsgType.BINARY:
                            if self.live:
                                self.live.feed(message.data)
                        elif message.type == aiohttp.WSMsgType.TEXT:
                            try:
                                payload = json.loads(message.data)
                            except ValueError:
                                continue
                            if payload.get("type") == "broadcast_start":
                                # Set up synchronously so the audio frames right behind it are kept.
                                self._broadcast_open(payload)
                            else:
                                asyncio.create_task(self._on_server_message(payload))
                        elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                            break
                    log.warning("server closed the connection (%s)", ws.close_code)
            except aiohttp.WSServerHandshakeError as error:
                if error.status == 401:
                    log.error("server rejected the device id/key; check %s", os.environ.get("GRAMSETU_CONFIG", "config"))
                elif error.status == 423:
                    log.warning("speaker is in maintenance on the server")
                else:
                    log.warning("connection refused: HTTP %s", error.status)
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as error:
                log.warning("offline: %s", error)
            finally:
                self.ws = None
                if self.live:
                    asyncio.create_task(self._broadcast_close(self.live, "STOPPED", "Connection to the server was lost"))
            await asyncio.sleep(backoff + random.random() * 2)
            backoff = min(backoff * 2, 60)

    async def _send(self, payload: dict):
        ws = self.ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_str(json.dumps(payload))
        except (ConnectionError, RuntimeError, aiohttp.ClientError) as error:
            log.debug("send failed: %s", error)

    async def _on_server_message(self, payload: dict):
        if payload.get("type") == "sync":
            self.sync_now.set()
        elif payload.get("type") == "logs_ack":
            self.store.drop_logs([item for item in payload.get("ids", []) if isinstance(item, str)])
            self.logs_acked.set()
        elif payload.get("type") == "broadcast_end":
            if self.live and self.live.id == payload.get("id"):
                await self._broadcast_close(self.live, "COMPLETED")
        elif payload.get("type") == "tunnel_open":
            await self._tunnel(str(payload.get("id") or ""))
        elif payload.get("type") == "command":
            reply = {"type": "command_result", "id": payload.get("id")}
            try:
                result = await self._command(payload)
                if isinstance(result, tuple):
                    reply["message"], reply["data"] = result
                else:
                    reply["message"] = result
                reply["ok"] = True
            except CommandError as error:
                reply.update(ok=False, error=str(error))
            except Exception as error:  # noqa: BLE001
                log.exception("command %s failed", payload.get("action"))
                reply.update(ok=False, error=f"Speaker error: {error}")
            reply["state"] = await self._state()
            await self._send(reply)
            self.state_now.set()

    # ---- commands from the dashboard ----------------------------------------

    async def _command(self, payload: dict) -> str | tuple[str, dict]:
        action = payload.get("action")
        log.info("command: %s", action)
        if self.live and action in ("stop", "skip"):
            await self._broadcast_close(self.live, "STOPPED", "Stopped by operator", notify=True)
            return "Left the live broadcast"
        if self.live and action in ("play", "resume", "pause"):
            raise CommandError("A live broadcast is playing. Stop or skip to leave it.")
        if action in ("play", "resume"):
            async with self.lock:
                if self.current and self.paused:
                    await self.player.set_paused(False)
                    self.paused = False
                    return "Resumed"
                if self.current:
                    return "Already playing"
                if not self.queue:
                    raise CommandError("Nothing is queued to play")
                await self._advance()
                return "Playing next item"
        if action == "pause":
            async with self.lock:
                if not self.current:
                    raise CommandError("Nothing is playing")
                await self.player.set_paused(True)
                self.paused = True
                return "Paused"
        if action == "stop":
            async with self.lock:
                cleared = self.queue
                self.queue = []
                for item in cleared:
                    self._record(item, "STOPPED", "Cleared by operator")
                if self.current:
                    self.current.end_result = "STOPPED"
                    self.current.end_error = "Stopped by operator"
                    await self.player.stop()
                return f"Stopped and cleared {len(cleared)} queued item(s)"
        if action == "skip":
            async with self.lock:
                if not self.current:
                    raise CommandError("Nothing is playing")
                self.current.end_result = "SKIPPED"
                self.current.end_error = "Skipped by operator"
                await self.player.stop()
                return "Skipped"
        if action in ("volume_up", "volume_down", "volume_set"):
            if action == "volume_set":
                target = int(payload.get("value", self.volume))
            else:
                target = self.volume + (10 if action == "volume_up" else -10)
            await self._set_volume(max(0, min(100, target)))
            return f"Volume {self.volume}%"
        if action == "play_audio":
            audio = payload.get("audio") or {}
            if not audio.get("id"):
                raise CommandError("No audio file given")
            path = await self._ensure_audio(audio)
            if not path:
                raise CommandError("Could not download the audio file")
            await self.enqueue(Item(source="LIVE_TEST", title=audio.get("title") or "Live test", audio=audio))
            return f"Playing “{audio.get('title') or 'test audio'}”"
        if action == "sync":
            await self.sync()
            return "Synced with server"
        if action == "log_level":
            try:
                self.logbook.set_level_name(payload.get("value", "INFO"))
            except ValueError as error:
                raise CommandError(str(error)) from error
            self.store.set("log_level", self.logbook.level_name)
            log.warning("log level set to %s from the server", self.logbook.level_name)
            return f"Log level {self.logbook.level_name}"
        if action == "journal":
            return await self._journal(payload)
        raise CommandError(f"Unknown command {action}")

    # ---- diagnostics ---------------------------------------------------------

    async def _run(self, args: list[str], timeout: float = 20) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
            )
        except FileNotFoundError:
            return f"({args[0]} is not installed)\n"
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout)
        except asyncio.TimeoutError:
            process.kill()
            return f"({args[0]} timed out)\n"
        return output.decode("utf-8", "replace")

    async def _journal(self, payload: dict) -> tuple[str, dict]:
        source = payload.get("source", "agent")
        if source == "diagnostics":
            parts = []
            for title, args in DIAGNOSTICS:
                parts.append(f"===== {title} =====\n{(await self._run(args, 10)).rstrip()}\n")
            text = "\n".join(parts)
        else:
            if source not in JOURNAL_ARGS:
                raise CommandError(f"Unknown log source {source}")
            lines = max(10, min(5000, int(payload.get("lines") or 500)))
            args = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(lines), *JOURNAL_ARGS[source]]
            if payload.get("since"):
                args += ["--since", str(payload["since"])]
            text = await self._run(args, 25)
        truncated = len(text.encode()) > MAX_JOURNAL_BYTES
        if truncated:
            text = text.encode()[-MAX_JOURNAL_BYTES:].decode("utf-8", "ignore")
            text = text[text.find("\n") + 1:]
        return f"Fetched {source} logs", {"text": text, "truncated": truncated}

    # ---- remote shell --------------------------------------------------------

    async def _tunnel(self, tunnel_id: str):
        """Pipe the local SSH server to GramSetu so an admin can log in from the web panel."""
        if not tunnel_id:
            return
        if not self.config.remote_shell:
            await self._send({"type": "tunnel_error", "id": tunnel_id, "error": "Remote shell is turned off on this speaker"})
            return
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.config.ssh_port), 5)
        except (OSError, asyncio.TimeoutError) as error:
            log.warning("remote shell: SSH is not reachable on port %s: %s", self.config.ssh_port, error)
            await self._send(
                {"type": "tunnel_error", "id": tunnel_id, "error": f"SSH is not running on the speaker (port {self.config.ssh_port})"}
            )
            return
        url = f"{self.config.ws_base}/ws/tunnel?id={tunnel_id}"
        log.info("remote shell session starting")
        try:
            async with self.session.ws_connect(url, heartbeat=25, max_msg_size=0) as ws:

                async def upstream():
                    while True:
                        chunk = await reader.read(64 * 1024)
                        if not chunk:
                            break
                        await ws.send_bytes(chunk)
                    await ws.close()

                pump = asyncio.create_task(upstream())
                try:
                    async for message in ws:
                        if message.type == aiohttp.WSMsgType.BINARY:
                            writer.write(message.data)
                            await writer.drain()
                        elif message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                            break
                finally:
                    pump.cancel()
        except Exception as error:  # noqa: BLE001
            log.warning("remote shell tunnel failed: %s", error)
            await self._send({"type": "tunnel_error", "id": tunnel_id, "error": f"Tunnel failed: {error}"})
        finally:
            writer.close()
            log.info("remote shell session ended")

    async def _set_volume(self, volume: int):
        self.volume = volume
        self.store.set("volume", volume)
        if self.live:
            await self.live.set_volume(volume)
        try:
            await self.player.set_volume(volume)
        except (PlayerError, asyncio.TimeoutError) as error:
            raise CommandError(f"Player is not ready: {error}") from error

    # ---- live broadcast ------------------------------------------------------

    def _broadcast_open(self, payload: dict):
        previous = self.live
        stream = LiveStream(
            payload,
            self.config.mpv_path,
            self.config.audio_device,
            self.volume,
            os.path.join(self.config.data_dir, "live.sock"),
        )
        self.live = stream
        asyncio.create_task(self._broadcast_begin(stream, previous))

    async def _broadcast_begin(self, stream: LiveStream, previous: LiveStream | None):
        if previous:
            await previous.finish()
            self._record_broadcast(previous, "STOPPED", "Replaced by a newer broadcast")
        async with self.lock:
            if self.current and not self.current.requeue:
                self.current.requeue = True
                await self.player.stop()
        # The main player has to let go of the audio device first.
        for _ in range(40):
            if self.current is None:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.2)
        if self.live is not stream:
            return
        try:
            await stream.start()
        except OSError as error:
            log.error("broadcast player failed to start: %s", error)
            await self._broadcast_close(stream, "FAILED", f"Player failed to start: {error}", notify=True)
            return
        log.info("live broadcast started: %s (from %s)", stream.title, stream.sender or "unknown")
        await self._send({"type": "broadcast_state", "id": stream.id, "state": "playing"})
        self.state_now.set()
        code = await stream.wait()
        if self.live is stream:
            await self._broadcast_close(stream, "FAILED", f"Player stopped unexpectedly (exit {code})", notify=True)

    async def _broadcast_close(self, stream: LiveStream, result: str, error: str | None = None, notify: bool = False):
        if self.live is not stream:
            return
        self.live = None
        await stream.finish()
        self._record_broadcast(stream, result, error)
        log.info("live broadcast ended: %s (%s)", stream.title, error or result.lower())
        if notify:
            state = "failed" if result == "FAILED" else "ended"
            await self._send({"type": "broadcast_state", "id": stream.id, "state": state, "error": error})
        async with self.lock:
            await self._advance()
        self.state_now.set()

    def _record_broadcast(self, stream: LiveStream, result: str, error: str | None):
        item = Item(source="BROADCAST", title=f"Live broadcast: {stream.title}"[:200], audio={}, broadcast_id=stream.id)
        item.started_at = stream.started_at
        self._record(item, result, error)

    # ---- play queue ----------------------------------------------------------

    async def enqueue(self, item: Item):
        async with self.lock:
            item.seq = next(self._seq)
            self.queue.append(item)
            self.queue.sort(key=lambda queued: (PRIORITY[queued.source], queued.seq))
            current = self.current
            if current and PRIORITY[item.source] < PRIORITY[current.source] and not current.requeue:
                current.requeue = True
                await self.player.stop()
            elif not current:
                await self._advance()
        self.state_now.set()

    async def _advance(self):
        """Start the next item. Caller holds self.lock."""
        if self.live:
            return
        while self.current is None and self.queue:
            item = self.queue.pop(0)
            path = self._cached_path(item.audio)
            if not path and self.online:
                self.lock.release()
                try:
                    path = await self._ensure_audio(item.audio)
                finally:
                    await self.lock.acquire()
                if self.current is not None:
                    self.queue.insert(0, item)
                    return
            if not path:
                self._record(item, "FAILED", "Audio file is not stored on the speaker")
                continue
            item.started_at = now_utc()
            item.offline = not self.online
            try:
                item.entry_id = await self.player.load(path)
            except (PlayerError, asyncio.TimeoutError) as error:
                self._record(item, "FAILED", f"Player error: {error}")
                continue
            self.current = item
            self.paused = False
            log.info("playing %s: %s", item.source.lower(), item.title)
        self.state_now.set()

    def _on_player_end(self, entry_id, reason, error):
        asyncio.get_running_loop().create_task(self._finish(entry_id, reason, error))

    def _on_player_crash(self):
        asyncio.get_running_loop().create_task(self._finish(None, "error", "Player crashed"))

    async def _finish(self, entry_id, reason, error):
        async with self.lock:
            item = self.current
            if item is None:
                return
            if entry_id is not None and item.entry_id is not None and entry_id != item.entry_id:
                return
            self.current = None
            self.paused = False
            if item.requeue:
                item.requeue = False
                item.entry_id = None
                item.seq = next(self._front)
                self.queue.append(item)
                self.queue.sort(key=lambda queued: (PRIORITY[queued.source], queued.seq))
            elif item.end_result:
                self._record(item, item.end_result, item.end_error)
            elif reason == "eof":
                self._record(item, "COMPLETED")
            elif reason == "error":
                self._record(item, "FAILED", error or "Playback error")
            else:
                self._record(item, "STOPPED", f"Playback ended ({reason})")
            await self._advance()
        self.state_now.set()

    def _record(self, item: Item, result: str, error: str | None = None):
        ended = now_utc()
        started = item.started_at
        report = {
            "localId": item.local_id,
            "source": item.source,
            "result": result,
            "title": item.title[:200],
            "scheduleId": item.schedule_id,
            "deliveryId": item.delivery_id,
            "broadcastId": item.broadcast_id,
            "audioFileId": item.audio.get("id"),
            "scheduledFor": iso(item.scheduled_for),
            "startedAt": iso(started) or iso(ended),
            "endedAt": iso(ended),
            "durationMs": int((ended - started).total_seconds() * 1000) if started else 0,
            "error": error[:500] if error else None,
            "playedOffline": item.offline or not self.online,
        }
        self.store.add_report(report)
        if item.delivery_id:
            self.store.finish_delivery(item.delivery_id)
            self.queued_deliveries.discard(item.delivery_id)
        log.info("%s: %s (%s)", result.lower(), item.title, error or "ok")
        self.flush_now.set()

    # ---- schedules and announcements ------------------------------------------

    async def _schedule_loop(self):
        last_prune = 0.0
        while True:
            now = now_utc()
            schedules = self.store.schedules()
            for schedule, at in scheduling.due(schedules, now, self.config.schedule_grace_seconds):
                key = scheduling.occurrence_key(schedule, at)
                if self.store.occurrence_done(key):
                    continue
                self.store.mark_occurrence(key)
                await self.enqueue(
                    Item(
                        source="SCHEDULE",
                        title=schedule["title"],
                        audio=schedule["audio"],
                        schedule_id=schedule["id"],
                        scheduled_for=at,
                    )
                )
            for delivery in self.store.pending_deliveries():
                if delivery["id"] in self.queued_deliveries:
                    continue
                play_at = parse_iso(delivery.get("playAt"))
                if play_at and play_at > now:
                    continue
                self.queued_deliveries.add(delivery["id"])
                await self.enqueue(
                    Item(
                        source="ANNOUNCEMENT",
                        title=delivery["title"],
                        audio=delivery["audio"],
                        delivery_id=delivery["id"],
                        scheduled_for=play_at,
                    )
                )
            if time.monotonic() - last_prune > 3600:
                last_prune = time.monotonic()
                self.store.prune()
            await asyncio.sleep(1)

    async def _sync_loop(self):
        while True:
            try:
                await asyncio.wait_for(self.sync_now.wait(), self.config.sync_interval_seconds)
            except asyncio.TimeoutError:
                pass
            self.sync_now.clear()
            try:
                await self.sync()
            except Exception as error:  # noqa: BLE001
                self.last_error = f"Sync failed: {error}"
                log.warning("sync failed: %s", error)

    async def sync(self):
        async with self.sync_lock:
            async with self.session.get(self.config.url("/api/device/sync")) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                data = await response.json()

            server_time = parse_iso(data.get("serverTime"))
            if server_time:
                self.clock_skew = (server_time - now_utc()).total_seconds()
                if abs(self.clock_skew) > 60:
                    log.warning("clock is off by %.0f s; schedules depend on the system clock", self.clock_skew)

            self.store.replace_schedules(data.get("schedules", []))
            server_deliveries = data.get("deliveries", [])
            for delivery in server_deliveries:
                self.store.add_delivery(delivery)
            self.store.drop_pending_deliveries({item["id"] for item in server_deliveries})

            needed = {item["audio"]["id"]: item["audio"] for item in data.get("schedules", [])}
            for delivery in self.store.pending_deliveries():
                needed[delivery["audio"]["id"]] = delivery["audio"]
            for audio in needed.values():
                await self._ensure_audio(audio)
            self._prune_cache(set(needed))

            self.store.set("last_sync_at", iso(now_utc()))
            self.last_error = None
            log.info("synced: %d schedule(s), %d announcement(s)", len(data.get("schedules", [])), len(server_deliveries))
        self.state_now.set()

    # ---- audio cache ---------------------------------------------------------

    def _cached_path(self, audio: dict) -> str | None:
        path = os.path.join(self.cache_dir, f"{audio['id']}.wav")
        if not os.path.exists(path):
            return None
        size = audio.get("sizeBytes")
        if size and os.path.getsize(path) != size:
            return None
        return path

    async def _ensure_audio(self, audio: dict) -> str | None:
        lock = self.download_locks.setdefault(audio["id"], asyncio.Lock())
        async with lock:
            path = self._cached_path(audio)
            if path:
                return path
            target = os.path.join(self.cache_dir, f"{audio['id']}.wav")
            partial = target + ".part"
            url = self.config.url(audio.get("url") or f"/api/device/audio/{audio['id']}")
            try:
                async with self.session.get(url) as response:
                    if response.status != 200:
                        raise RuntimeError(f"HTTP {response.status}")
                    with open(partial, "wb") as handle:
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            handle.write(chunk)
                size = audio.get("sizeBytes")
                if size and os.path.getsize(partial) != size:
                    raise RuntimeError("downloaded size does not match")
                os.replace(partial, target)
                log.info("downloaded %s", audio.get("title") or audio["id"])
                return target
            except Exception as error:  # noqa: BLE001
                log.warning("download of %s failed: %s", audio.get("title") or audio["id"], error)
                if os.path.exists(partial):
                    os.unlink(partial)
                return None

    def _prune_cache(self, keep: set[str]):
        busy = {item.audio.get("id") for item in self.queue}
        if self.current:
            busy.add(self.current.audio.get("id"))
        cutoff = time.time() - 86400
        for name in os.listdir(self.cache_dir):
            audio_id = name.split(".")[0]
            path = os.path.join(self.cache_dir, name)
            if audio_id in keep or audio_id in busy:
                continue
            # Keep recent live-test files around for a day.
            if os.path.getmtime(path) < cutoff:
                os.unlink(path)

    # ---- reports and live state ----------------------------------------------

    async def _report_loop(self):
        while True:
            try:
                await asyncio.wait_for(self.flush_now.wait(), self.config.report_flush_seconds)
            except asyncio.TimeoutError:
                pass
            self.flush_now.clear()
            while True:
                batch = self.store.unsynced_reports(100)
                if not batch:
                    break
                try:
                    async with self.session.post(self.config.url("/api/device/reports"), json={"reports": batch}) as response:
                        if response.status != 200:
                            raise RuntimeError(f"HTTP {response.status}: {await response.text()}")
                        accepted = (await response.json()).get("accepted", [])
                except Exception as error:  # noqa: BLE001
                    log.debug("report upload failed: %s", error)
                    break
                self.store.mark_reports_synced(accepted)
                self.state_now.set()
                if len(accepted) < len(batch):
                    break

    def _persist_logs(self):
        entries = self.logbook.drain()
        if entries:
            self.store.add_logs(entries)

    async def _log_loop(self):
        """Stream log lines to the server; lines written while offline go once it reconnects."""
        while True:
            self._persist_logs()
            batch = self.store.unsent_logs() if self.online else []
            if not batch:
                await asyncio.sleep(1)
                continue
            self.logs_acked.clear()
            await self._send({"type": "logs", "entries": batch})
            try:
                await asyncio.wait_for(self.logs_acked.wait(), 15)
            except asyncio.TimeoutError:
                await asyncio.sleep(1)

    async def _state_loop(self):
        while True:
            interval = self.config.state_interval_seconds if self.current else 30
            try:
                await asyncio.wait_for(self.state_now.wait(), interval)
            except asyncio.TimeoutError:
                pass
            self.state_now.clear()
            await self._check_stalled()
            if self.online:
                await self._send({"type": "state", "state": await self._state()})

    async def _check_stalled(self):
        """Recover if mpv went idle without telling us (missed end-file event)."""
        item = self.current
        if not item or not item.started_at or (now_utc() - item.started_at).total_seconds() < 5:
            return
        if await self.player.get("idle-active") is True:
            log.warning("player went idle without an end event")
            await self._finish(item.entry_id, "error", "Playback ended unexpectedly")

    async def _state(self) -> dict:
        item = self.current
        now_playing = None
        live = self.live
        if live:
            now_playing = {
                "title": live.title,
                "source": "BROADCAST",
                "scheduleId": None,
                "broadcastId": live.id,
                "from": live.sender,
                "startedAt": iso(live.started_at),
                "position": round(live.seconds, 1),
                "duration": None,
            }
        elif item:
            now_playing = {
                **item.brief(),
                "audioFileId": item.audio.get("id"),
                "deliveryId": item.delivery_id,
                "startedAt": iso(item.started_at),
                "position": await self.player.get("time-pos"),
                "duration": await self.player.get("duration"),
            }
        upcoming = scheduling.next_occurrence(self.store.schedules(), now_utc())
        disk = shutil.disk_usage(self.config.data_dir)
        return {
            "status": "broadcast" if live else "paused" if item and self.paused else "playing" if item else "idle",
            "volume": self.volume,
            "nowPlaying": now_playing,
            "queue": [queued.brief() for queued in self.queue[:10]],
            "queueLength": len(self.queue),
            "nextSchedule": {"scheduleId": upcoming[0]["id"], "title": upcoming[0]["title"], "at": iso(upcoming[1])} if upcoming else None,
            "schedules": len(self.store.schedules()),
            "cachedFiles": len([name for name in os.listdir(self.cache_dir) if name.endswith(".wav")]),
            "pendingReports": self.store.unsynced_count(),
            "pendingLogs": self.store.log_count(),
            "logLevel": self.logbook.level_name,
            "remoteShell": self.config.remote_shell,
            "lastSyncAt": self.store.get("last_sync_at"),
            "clockSkewSeconds": round(self.clock_skew) if self.clock_skew is not None else None,
            "lastError": self.last_error,
            "diskFreeMb": disk.free // (1024 * 1024),
            "uptimeSeconds": int(time.monotonic() - self.started),
            "agentVersion": VERSION,
            "time": iso(now_utc()),
        }
