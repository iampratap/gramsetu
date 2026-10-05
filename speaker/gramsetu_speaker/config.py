import json
import os
from dataclasses import dataclass, fields

DEFAULT_PATH = "/etc/gramsetu-speaker/config.json"


@dataclass
class Config:
    server_url: str = ""
    device_id: str = ""
    device_key: str = ""
    data_dir: str = "/var/lib/gramsetu-speaker"
    # Passed to mpv --audio-device; "auto" lets mpv pick. See `mpv --audio-device=help`.
    audio_device: str = "auto"
    mpv_path: str = "mpv"
    default_volume: int = 80
    sync_interval_seconds: int = 300
    # How late a scheduled play may start (e.g. after a reboot) before it is skipped.
    schedule_grace_seconds: int = 600
    report_flush_seconds: int = 15
    state_interval_seconds: int = 5
    # Lowest level sent to the GramSetu log viewer; admins can change it at runtime.
    log_level: str = "INFO"
    # Lets admins open an SSH session from the web panel through the agent's connection.
    remote_shell: bool = True
    ssh_port: int = 22

    @property
    def ws_base(self) -> str:
        base = self.server_url.rstrip("/")
        if base.startswith("https://"):
            return "wss://" + base[len("https://"):]
        if base.startswith("http://"):
            return "ws://" + base[len("http://"):]
        raise ValueError("server_url must start with http:// or https://")

    @property
    def ws_url(self) -> str:
        return self.ws_base + "/ws/device"

    def url(self, path: str) -> str:
        return self.server_url.rstrip("/") + path

    @property
    def auth_headers(self) -> dict:
        return {"X-Device-Id": self.device_id, "X-Device-Key": self.device_key}


def load(path: str | None = None) -> Config:
    path = path or os.environ.get("GRAMSETU_CONFIG", DEFAULT_PATH)
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    known = {field.name for field in fields(Config)}
    config = Config(**{key: value for key, value in raw.items() if key in known})
    missing = [name for name in ("server_url", "device_id", "device_key") if not getattr(config, name)]
    if missing:
        raise SystemExit(f"{path} is missing: {', '.join(missing)}")
    config.ws_url  # validates the URL scheme
    return config
