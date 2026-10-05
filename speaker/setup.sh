#!/usr/bin/env bash
# GramSetu speaker node installer for Raspberry Pi OS (Bookworm). Lite is recommended.
#
# First install (values come from the Speakers page in GramSetu):
#   sudo ./setup.sh --server https://app.mahagramvani.in --device-id spk-rampur-school --device-key <key>
#
# Update the code later, keeping the existing config:
#   sudo ./setup.sh
#
# Options:
#   --server URL          GramSetu server, e.g. https://gramsetu.example.com
#   --device-id ID        Speaker device id
#   --device-key KEY      Speaker device key
#   --timezone TZ         System timezone (default Asia/Kolkata)
#   --audio-device NAME   mpv audio device (default auto; list with: mpv --audio-device=help)
#   --volume N            Starting volume 0-100 (default 80)
#   --hostname NAME       Set the Pi hostname, e.g. the device id
#   --test-sound          Play a short test tone through the speaker after install
#   --no-remote-shell     Do not allow SSH from the GramSetu web panel (default: allowed)
#   --ssh-local-only      SSH only through the web panel; sshd stops listening on the network
#   --network NAME        Set up the 4G/USB modem SIM: airtel, jio, vi or bsnl (connects on boot)
#   --apn APN             Use this APN instead of the operator default (needs --network)
#   --sim-pin PIN         SIM PIN, only if the SIM card is locked
set -euo pipefail

APP_DIR=/opt/gramsetu-speaker
CONF_DIR=/etc/gramsetu-speaker
CONF_FILE="$CONF_DIR/config.json"
DATA_DIR=/var/lib/gramsetu-speaker
SERVICE_USER=gramsetu
SERVICE=gramsetu-speaker
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER="" DEVICE_ID="" DEVICE_KEY="" TIMEZONE="Asia/Kolkata" AUDIO_DEVICE="auto" VOLUME=80 NEW_HOSTNAME="" TEST_SOUND=0
REMOTE_SHELL=1 SSH_LOCAL_ONLY=0 NETWORK="" APN="" SIM_PIN=""
declare -A OPERATOR_APN=([airtel]=airtel [jio]=jionet [vi]=www [bsnl]=bsnlnet)

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --device-id) DEVICE_ID="${2:-}"; shift 2 ;;
    --device-key) DEVICE_KEY="${2:-}"; shift 2 ;;
    --timezone) TIMEZONE="${2:-}"; shift 2 ;;
    --audio-device) AUDIO_DEVICE="${2:-}"; shift 2 ;;
    --volume) VOLUME="${2:-}"; shift 2 ;;
    --hostname) NEW_HOSTNAME="${2:-}"; shift 2 ;;
    --test-sound) TEST_SOUND=1; shift ;;
    --no-remote-shell) REMOTE_SHELL=0; shift ;;
    --ssh-local-only) SSH_LOCAL_ONLY=1; shift ;;
    --network) NETWORK="${2:-}"; shift 2 ;;
    --apn) APN="${2:-}"; shift 2 ;;
    --sim-pin) SIM_PIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ -d "$SRC_DIR/gramsetu_speaker" ]] || die "run this from the speaker folder (gramsetu_speaker/ not found)"
[[ "$VOLUME" =~ ^[0-9]+$ && "$VOLUME" -le 100 ]] || die "--volume must be 0-100"
if [[ -n "$NETWORK" ]]; then
  NETWORK="${NETWORK,,}"
  [[ -n "${OPERATOR_APN[$NETWORK]:-}" ]] || die "--network must be one of: airtel, jio, vi, bsnl"
  APN="${APN:-${OPERATOR_APN[$NETWORK]}}"
elif [[ -n "$APN$SIM_PIN" ]]; then
  die "--apn and --sim-pin need --network"
fi

WRITE_CONFIG=1
if [[ -z "$SERVER$DEVICE_ID$DEVICE_KEY" && -f "$CONF_FILE" ]]; then
  WRITE_CONFIG=0
  echo "Keeping existing $CONF_FILE (pass --server/--device-id/--device-key to replace it)."
else
  if [[ -t 0 ]]; then
    [[ -n "$SERVER" ]] || read -rp "GramSetu server URL: " SERVER
    [[ -n "$DEVICE_ID" ]] || read -rp "Device id: " DEVICE_ID
    [[ -n "$DEVICE_KEY" ]] || { read -rsp "Device key: " DEVICE_KEY; echo; }
  fi
  [[ -n "$SERVER" && -n "$DEVICE_ID" && -n "$DEVICE_KEY" ]] || die "--server, --device-id and --device-key are required"
  [[ "$SERVER" =~ ^https?:// ]] || die "--server must start with http:// or https://"
  SERVER="${SERVER%/}"
fi

step "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-aiohttp mpv alsa-utils ca-certificates curl openssh-server >/dev/null
python3 -c 'import aiohttp, zoneinfo' || die "python3-aiohttp did not install correctly"

if [[ -n "$NETWORK" ]]; then
  step "Setting up the $NETWORK SIM connection (APN $APN)"
  apt-get install -y -qq network-manager modemmanager libqmi-utils udhcpc >/dev/null
  systemctl enable --now NetworkManager ModemManager >/dev/null
  # One SIM connection at a time, so switching operators does not leave the old one competing.
  for name in "${!OPERATOR_APN[@]}"; do
    if nmcli -t -f NAME connection show | grep -qx "$name"; then
      nmcli connection delete "$name" >/dev/null
    fi
  done
  pin=()
  [[ -n "$SIM_PIN" ]] && pin=(gsm.pin "$SIM_PIN")
  nmcli connection add type gsm ifname '*' con-name "$NETWORK" apn "$APN" \
    connection.autoconnect yes connection.autoconnect-retries 0 "${pin[@]}" >/dev/null
  for _ in $(seq 1 10); do
    mmcli -L 2>/dev/null | grep -q /Modem/ && break
    sleep 2
  done
  if ! mmcli -L 2>/dev/null | grep -q /Modem/; then
    echo "warning: no modem found yet. Check the dongle/HAT and SIM; the connection starts by itself once the modem appears."
  elif nmcli connection up "$NETWORK" >/dev/null 2>&1; then
    echo "Connected over $NETWORK mobile data."
  else
    echo "warning: modem found but $NETWORK did not connect yet (signal, SIM or APN). It keeps retrying on its own."
    echo "         Check with: mmcli -m any   and   nmcli connection show $NETWORK"
  fi
fi

if [[ $REMOTE_SHELL -eq 1 ]]; then
  step "Enabling SSH for the GramSetu remote shell"
  if [[ $SSH_LOCAL_ONLY -eq 1 ]]; then
    printf '# Written by GramSetu setup.sh: SSH only through the GramSetu web panel.\nListenAddress 127.0.0.1\nListenAddress ::1\n' \
      > /etc/ssh/sshd_config.d/gramsetu.conf
  else
    rm -f /etc/ssh/sshd_config.d/gramsetu.conf
  fi
  systemctl enable ssh >/dev/null 2>&1 || true
  systemctl restart ssh || echo "warning: could not start sshd; remote shell will not work"
  echo "Log in from the web panel with an existing Pi user (e.g. the one created when flashing the SD card)."
fi

step "Setting timezone to $TIMEZONE and enabling network time"
timedatectl set-timezone "$TIMEZONE" || die "unknown timezone $TIMEZONE"
timedatectl set-ntp true || echo "warning: could not enable NTP; keep the clock correct for schedules"

if [[ -n "$NEW_HOSTNAME" ]]; then
  step "Setting hostname to $NEW_HOSTNAME"
  hostnamectl set-hostname "$NEW_HOSTNAME"
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
fi

step "Creating service user and folders"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG audio,video,systemd-journal "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR" "$DATA_DIR/audio"
install -d -m 755 "$APP_DIR" "$CONF_DIR"

step "Installing agent to $APP_DIR"
rm -rf "$APP_DIR/gramsetu_speaker"
cp -r "$SRC_DIR/gramsetu_speaker" "$APP_DIR/"
find "$APP_DIR" -name '__pycache__' -prune -exec rm -rf {} +
chown -R root:root "$APP_DIR"

if [[ $WRITE_CONFIG -eq 1 ]]; then
  step "Writing $CONF_FILE"
  SERVER="$SERVER" DEVICE_ID="$DEVICE_ID" DEVICE_KEY="$DEVICE_KEY" AUDIO_DEVICE="$AUDIO_DEVICE" \
  VOLUME="$VOLUME" DATA_DIR="$DATA_DIR" CONF_FILE="$CONF_FILE" python3 - <<'PY'
import json, os
config = {
    "server_url": os.environ["SERVER"],
    "device_id": os.environ["DEVICE_ID"],
    "device_key": os.environ["DEVICE_KEY"],
    "data_dir": os.environ["DATA_DIR"],
    "audio_device": os.environ["AUDIO_DEVICE"],
    "default_volume": int(os.environ["VOLUME"]),
    "sync_interval_seconds": 300,
    "schedule_grace_seconds": 600,
    "report_flush_seconds": 15,
    "state_interval_seconds": 5,
    "log_level": "INFO",
}
with open(os.environ["CONF_FILE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
PY
fi
REMOTE_SHELL="$REMOTE_SHELL" CONF_FILE="$CONF_FILE" python3 - <<'PY'
import json, os
path = os.environ["CONF_FILE"]
with open(path, encoding="utf-8") as handle:
    config = json.load(handle)
config["remote_shell"] = os.environ["REMOTE_SHELL"] == "1"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
PY
chown root:"$SERVICE_USER" "$CONF_FILE"
chmod 640 "$CONF_FILE"

step "Checking the server"
read -r CHECK_URL CHECK_ID CHECK_KEY < <(python3 -c '
import json, sys
c = json.load(open(sys.argv[1]))
print(c["server_url"], c["device_id"], c["device_key"])' "$CONF_FILE")
if curl -fsS --max-time 10 "$CHECK_URL/api/health" >/dev/null; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "X-Device-Id: $CHECK_ID" -H "X-Device-Key: $CHECK_KEY" "$CHECK_URL/api/device/sync" || true)
  case "$code" in
    200) echo "Server reachable and device credentials accepted." ;;
    401) echo "warning: server rejected the device id/key. Fix $CONF_FILE, then: sudo systemctl restart $SERVICE" ;;
    423) echo "warning: this speaker is in maintenance on the server." ;;
    *) echo "warning: device check returned HTTP $code" ;;
  esac
else
  echo "warning: cannot reach $CHECK_URL right now. The speaker will keep retrying and play stored schedules meanwhile."
fi

step "Installing systemd service"
install -m 644 "$SRC_DIR/gramsetu-speaker.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 3

if [[ $TEST_SOUND -eq 1 ]]; then
  step "Playing a test tone"
  systemctl stop "$SERVICE"
  speaker-test -t sine -f 440 -l 1 -p 2 >/dev/null 2>&1 || echo "warning: speaker-test failed; check the audio output (raspi-config > System > Audio)"
  systemctl start "$SERVICE"
fi

step "Done"
systemctl --no-pager --lines=8 status "$SERVICE" || true
cat <<EOF

The speaker node is installed and starts on boot.
  Logs:     journalctl -u $SERVICE -f
  Restart:  sudo systemctl restart $SERVICE
  Config:   $CONF_FILE
  Storage:  $DATA_DIR (audio cache, offline reports and logs)
  Remote:   $( [[ $REMOTE_SHELL -eq 1 ]] && echo "SSH from GramSetu > Remote shell is enabled" || echo "remote shell disabled" )
$( [[ -n "$NETWORK" ]] && echo "  Network:  $NETWORK SIM (APN $APN), connects on boot. Status: nmcli connection show $NETWORK" )

If no sound comes out, list outputs with: aplay -l   and   mpv --audio-device=help
then set "audio_device" in $CONF_FILE (e.g. "alsa/plughw:CARD=Headphones") and restart.
EOF
