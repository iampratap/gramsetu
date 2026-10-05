"""Plays a live voice broadcast: raw PCM from the server piped into its own mpv process."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

log = logging.getLogger("broadcast")

# Frames that arrive while mpv is still starting are held, up to about 4 s of 16 kHz audio.
MAX_PENDING_BYTES = 128 * 1024
# If mpv stops reading (stalled audio device), drop audio rather than grow memory and latency.
MAX_PIPE_BACKLOG = 64 * 1024


class LiveStream:
    def __init__(self, payload: dict, mpv_path: str, audio_device: str, volume: int, ipc_path: str):
        self.id = str(payload.get("id") or "")
        self.title = str(payload.get("title") or "Live announcement")
        self.sender = str(payload.get("from") or "")
        self.sample_rate = int(payload.get("sampleRate") or 16000)
        self.channels = int(payload.get("channels") or 1)
        self.mpv_path = mpv_path
        self.audio_device = audio_device
        self.volume = volume
        self.ipc_path = ipc_path
        self.process: asyncio.subprocess.Process | None = None
        self.pending: list[bytes] = []
        self.pending_bytes = 0
        self.bytes = 0
        self.dropped = 0
        self.started_at = datetime.now(timezone.utc)
        self.closing = False

    async def start(self):
        if os.path.exists(self.ipc_path):
            os.unlink(self.ipc_path)
        args = [
            self.mpv_path,
            "--no-config",
            "--no-video",
            "--no-terminal",
            "--idle=no",
            "--cache=no",
            "--cache-pause=no",
            "--stream-buffer-size=4k",
            "--audio-buffer=0.15",
            "--demuxer=rawaudio",
            "--demuxer-rawaudio-format=s16le",
            f"--demuxer-rawaudio-rate={self.sample_rate}",
            f"--demuxer-rawaudio-channels={self.channels}",
            f"--volume={self.volume}",
            f"--input-ipc-server={self.ipc_path}",
        ]
        if self.audio_device and self.audio_device != "auto":
            args.append(f"--audio-device={self.audio_device}")
        args.append("-")
        self.process = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
        pending, self.pending, self.pending_bytes = self.pending, [], 0
        for chunk in pending:
            self.feed(chunk)

    def feed(self, data: bytes):
        if self.closing or not data:
            return
        process = self.process
        if process is None:
            if self.pending_bytes + len(data) <= MAX_PENDING_BYTES:
                self.pending.append(data)
                self.pending_bytes += len(data)
            else:
                self.dropped += len(data)
            return
        stdin = process.stdin
        if stdin is None or stdin.is_closing() or process.returncode is not None:
            return
        if stdin.transport.get_write_buffer_size() > MAX_PIPE_BACKLOG:
            self.dropped += len(data)
            return
        stdin.write(data)
        self.bytes += len(data)

    @property
    def seconds(self) -> float:
        return (datetime.now(timezone.utc) - self.started_at).total_seconds()

    async def set_volume(self, volume: int):
        self.volume = volume
        try:
            _reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(self.ipc_path), 1)
        except (OSError, asyncio.TimeoutError):
            return
        writer.write((json.dumps({"command": ["set_property", "volume", volume]}) + "\n").encode())
        await writer.drain()
        writer.close()

    async def wait(self) -> int:
        while self.process is None:
            await asyncio.sleep(0.1)
        return await self.process.wait()

    async def finish(self):
        """Let mpv play what it already has, then stop it."""
        self.closing = True
        process = self.process
        if process is None or process.returncode is not None:
            return
        try:
            if process.stdin and not process.stdin.is_closing():
                process.stdin.close()
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        except (ConnectionError, OSError):
            pass
        if self.dropped:
            log.warning("broadcast dropped %d KB of audio (slow network or audio device)", self.dropped // 1024)
