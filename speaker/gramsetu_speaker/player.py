"""Controls a long-running mpv process over its JSON IPC socket."""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os

log = logging.getLogger("player")


class PlayerError(Exception):
    pass


class MpvPlayer:
    def __init__(self, mpv_path, socket_path, audio_device, volume, on_end, on_crash):
        self.mpv_path = mpv_path
        self.socket_path = socket_path
        self.audio_device = audio_device
        self.volume = volume
        self.on_end = on_end  # (playlist_entry_id, reason, error) -> None
        self.on_crash = on_crash  # () -> None
        self.proc = None
        self.writer = None
        self.ready = asyncio.Event()
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}

    async def start(self):
        await self._spawn()

    async def _spawn(self):
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        args = [
            self.mpv_path,
            "--idle=yes",
            "--no-video",
            "--no-terminal",
            "--audio-display=no",
            "--keep-open=no",
            "--volume-max=100",
            f"--volume={self.volume}",
            f"--input-ipc-server={self.socket_path}",
        ]
        if self.audio_device and self.audio_device != "auto":
            args.append(f"--audio-device={self.audio_device}")
        self.proc = await asyncio.create_subprocess_exec(*args)

        for _ in range(100):
            if os.path.exists(self.socket_path):
                break
            if self.proc.returncode is not None:
                raise PlayerError(f"mpv exited with code {self.proc.returncode}")
            await asyncio.sleep(0.1)
        else:
            raise PlayerError("mpv did not open its IPC socket")

        reader, self.writer = await asyncio.open_unix_connection(self.socket_path)
        asyncio.create_task(self._read(reader))
        self.ready.set()
        log.info("mpv started (pid %s)", self.proc.pid)

    async def _read(self, reader):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                message = json.loads(line)
            except ValueError:
                continue
            request_id = message.get("request_id")
            if request_id in self._pending:
                future = self._pending.pop(request_id)
                if not future.done():
                    future.set_result(message)
            elif message.get("event") == "end-file":
                self.on_end(message.get("playlist_entry_id"), message.get("reason"), message.get("file_error"))

    async def supervise(self):
        """Restart mpv if it dies; playback in progress is reported as failed."""
        while True:
            await self.ready.wait()
            code = await self.proc.wait()
            self.ready.clear()
            self.writer = None
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(PlayerError("mpv exited"))
            self._pending.clear()
            log.warning("mpv exited with code %s; restarting", code)
            self.on_crash()
            while True:
                await asyncio.sleep(2)
                try:
                    await self._spawn()
                    break
                except Exception as error:  # noqa: BLE001
                    log.error("could not restart mpv: %s", error)

    async def command(self, *args, timeout: float = 5.0):
        await asyncio.wait_for(self.ready.wait(), timeout)
        request_id = next(self._ids)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        self.writer.write((json.dumps({"command": list(args), "request_id": request_id}) + "\n").encode())
        await self.writer.drain()
        try:
            reply = await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(request_id, None)
        if reply.get("error") != "success":
            raise PlayerError(reply.get("error", "mpv command failed"))
        return reply.get("data")

    async def load(self, path: str):
        """Start a file and return mpv's playlist entry id (None on older mpv)."""
        data = await self.command("loadfile", path, "replace")
        await self.command("set_property", "pause", False)
        return data.get("playlist_entry_id") if isinstance(data, dict) else None

    async def stop(self):
        await self.command("stop")

    async def set_paused(self, paused: bool):
        await self.command("set_property", "pause", paused)

    async def set_volume(self, volume: int):
        self.volume = volume
        await self.command("set_property", "volume", volume)

    async def get(self, name: str):
        try:
            return await self.command("get_property", name, timeout=2)
        except (PlayerError, asyncio.TimeoutError):
            return None

    async def shutdown(self):
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except asyncio.TimeoutError:
                self.proc.kill()
