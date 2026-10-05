# GramSetu

Announcement desk for villages. Platform admins set up areas and speakers. A maker uploads audio (normalized to 16 kHz 16-bit mono WAV and stored in S3), drafts an announcement, a checker approves or rejects it, and each IoT speaker polls for audio that is allowed to play.

## Roles


| Role        | What they do                                                   |
| ----------- | -------------------------------------------------------------- |
| Super admin | Everything an admin can do, plus creating platform admins                         |
| Admin       | Manages areas, speakers and users; creates *and* approves announcements in any area |
| Maker       | Uploads audio and creates, edits, pauses and deletes announcements in their area    |
| Checker     | Approves, rejects and pauses announcements in their area (not ones they created)    |


An announcement plays right after approval, once at a date and time, daily, or on chosen weekdays
(schedules are part of announcements; there is no separate schedule list). A speaker does not receive
it until it is approved, and editing an approved announcement sends it back for approval. Admins can
tick "Approve now" while creating or editing. One area can have many speaker locations.

## Audio pipeline

1. Maker uploads mp3/wav/ogg/m4a/aac (or attaches a new file while creating an announcement).
2. The API converts it with ffmpeg to **16 kHz, 16-bit, mono WAV**.
3. The WAV is stored in an **S3 bucket**; metadata (title, size, sample rate, S3 key) is saved in Postgres.

Set `STORAGE_DRIVER=s3` and the `S3_*` variables in `backend/.env` for object storage (this server uses DigitalOcean Spaces). Use `STORAGE_DRIVER=local` only if you want files on disk under `backend/uploads/s3`.

## Run it

Postgres on `localhost:5432`, plus **ffmpeg** on the PATH.

```bash
docker compose up -d

npm install
npm install --prefix backend
npm install --prefix frontend
cp backend/.env.example backend/.env   # if needed
npm run db:setup
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on [http://localhost:4000](http://localhost:4000).

## Production on Ubuntu (nginx)

On this server the stack is already wired as:


| Piece    | How it runs                                                   |
| -------- | ------------------------------------------------------------- |
| Postgres | Docker Compose (`gramsetu-db`, data in `./gramsetu_pg`)       |
| API      | Docker Compose (`gramsetu-api` on `127.0.0.1:4000`)           |
| Web UI   | Built React assets in `/var/www/gramsetu`                     |
| nginx    | Ports 80 and 443 → static UI + `/api` and `/ws` reverse proxy |
| Audio    | S3 / DigitalOcean Spaces via `backend/.env`                   |


```bash
# After code changes
./deploy.sh

# Useful checks
sudo docker compose ps
sudo systemctl status nginx
curl https://app.mahagramvani.in/api/health
```

Config copies live under `deploy/` (`nginx-gramsetu.conf`, `nginx-gramsetu-locations.conf`).

The site is served at **[https://app.mahagramvani.in](https://app.mahagramvani.in)** (set `GRAMSETU_DOMAIN` to deploy under another
name). On first run `deploy.sh` gets a Let's Encrypt certificate through `/.well-known/acme-challenge/`;
`certbot.timer` renews it and `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` reloads nginx.
Set `LETSENCRYPT_EMAIL` before the first deploy to get expiry notices. Any other address (plain HTTP,
or the bare IP) redirects to the domain, except `/api/device/`, `/ws/device`, `/ws/tunnel` and
`/downloads/` over HTTP, which keep working for speaker nodes that were set up with an `http://` address.
HTTPS is also what lets the Live broadcast page use the microphone.

## Demo accounts


| Role           | Email                                                                 | Password  |
| -------------- | --------------------------------------------------------------------- | --------- |
| Super admin    | [superadmin@gramsetu.local](mailto:superadmin@gramsetu.local)         | Super@123 |
| Admin          | [admin@gramsetu.local](mailto:admin@gramsetu.local)                   | Admin@123 |
| Rampur maker   | [rampur.maker@gramsetu.local](mailto:rampur.maker@gramsetu.local)     | Maker@123 |
| Rampur checker | [rampur.checker@gramsetu.local](mailto:rampur.checker@gramsetu.local) | Check@123 |


Devgarh uses the same maker/checker passwords with `devgarh.maker@gramsetu.local` and `devgarh.checker@gramsetu.local`.

## Raspberry Pi speaker node

The `speaker/` folder is the agent that runs on each Pi (Raspberry Pi OS Lite, Bookworm). It keeps a
WebSocket open to `/ws/device`, caches approved announcements and their audio in SQLite under
`/var/lib/gramsetu-speaker`, plays through mpv, and keeps playing timed and repeating announcements on its
own clock when the network is down. Play reports are stored on
the Pi and uploaded when it reconnects.

The audio cache cleans itself up. Audio is downloaded only for announcements that still have a play
time ahead. When an announcement is cancelled, deleted, paused, or given new audio, its file is deleted
at the next sync. A finished announcement's file is kept for `finished_keep_days` (7) after its last
play, so a rerun does not download it again. Live-test and one-off announcement files go
`played_keep_hours` (24) after they last played. A rescheduled or resumed announcement is downloaded
again. If free space drops below `min_free_mb` (300), unneeded files are deleted early, oldest first.
Files are never deleted while playing or queued, and clean-up also runs hourly while offline.
Each deletion is written to the device log with its reason. These settings can be changed in
`/etc/gramsetu-speaker/config.json`.

To install a new node, open the speaker in **Speakers → Edit** and run the setup command shown there on the Pi:

```bash
curl -fsSL https://app.mahagramvani.in/downloads/gramsetu-speaker.tar.gz | tar xz
cd gramsetu-speaker && sudo ./setup.sh --server https://app.mahagramvani.in --device-id ID --device-key KEY --network airtel
```

Drop `--network` if the Pi uses Wi-Fi or Ethernet only. With `--network airtel|jio|vi|bsnl` the installer
adds NetworkManager, ModemManager, libqmi-utils and udhcpc and creates a NetworkManager GSM connection for
the USB dongle or 4G HAT that connects on boot and keeps retrying. Default APNs are `airtel`,
`jionet`, `www` (Vi) and `bsnlnet`; override with `--apn APN`, and pass `--sim-pin PIN` for a
locked SIM. Running setup again with another `--network` replaces the old SIM connection. Run the
installer while the Pi still has internet (Wi-Fi, Ethernet or phone tethering), since it downloads
packages first. The **Edit & setup** dialog has a SIM network picker that adds the flag to the copied command.

At the end the installer prints:

```text
The speaker node is installed and starts on boot.
  Logs:     journalctl -u gramsetu-speaker -f
  Restart:  sudo systemctl restart gramsetu-speaker
  Config:   /etc/gramsetu-speaker/config.json
  Storage:  /var/lib/gramsetu-speaker (audio cache, offline reports and logs)
  Remote:   SSH from GramSetu > Remote shell is enabled

If no sound comes out, list outputs with: aplay -l   and   mpv --audio-device=help
then set "audio_device" in /etc/gramsetu-speaker/config.json (e.g. "alsa/plughw:CARD=Headphones") and restart.
```

`./setup.sh --help` lists the other options (`--timezone`, `--audio-device`, `--volume`, `--hostname`,
`--test-sound`, `--no-remote-shell`, `--ssh-local-only`, `--network`, `--apn`, `--sim-pin`). `deploy.sh` rebuilds the tarball.

### Live broadcast

**Live broadcast** lets anyone who can control speakers (admins for all areas, makers and checkers for
their own area) pick speakers and talk from the browser. The page records 16 kHz mono PCM in 40 ms
frames and sends it to `/ws/broadcast`; the API relays the frames over each speaker's device socket and
the Pi plays them through a separate low-latency mpv. Whatever was playing pauses and resumes
afterwards. Speakers that are offline or drop out join or rejoin automatically while the broadcast is
still running. Broadcasts are capped at 60 minutes, are listed in history, and each speaker files a
play report with source `BROADCAST`.

### Delivery status per speaker

The **Announcements** page shows the approval status (pending approval, approved, rejected) and, once
approved, a status for every speaker, refreshed every 30 seconds:

- **Pending**: the speaker has not received or finished downloading the audio yet (offline speakers
  get it when they reconnect).
- **Downloaded**: the audio is stored on the speaker and waiting for its time. Agents 1.4.0 and newer
  report their cached files over the device socket; older agents go straight from pending to played.
- **Played**: the last due play was reported as completed (including plays that happened offline and
  were reported later).
- **Not played**: the last play failed or was skipped, or a timed play has no report 15 minutes after
  it was due.

Open an announcement to see when each speaker downloaded it, when it last played, how many times,
and when it plays next.

### Diagnostics (super admin and admin only)

- **Device logs** streams the agent's log lines live (`/ws/logs`) and keeps them in Postgres for
`DEVICE_LOG_RETENTION_DAYS` (default 30) with search, level/date filters and `.log` export. Lines
written while a Pi is offline wait in its SQLite and upload on reconnect. "Turn debug on" switches a
speaker to DEBUG at runtime. "From the Pi" fetches the Pi's own journal (agent, system, boot, kernel)
or a health check (disk, memory, temperature, audio devices, network, clock).
- **Remote shell** is SSH in the browser. The Pi opens a tunnel from its local sshd to `/ws/tunnel`
over its existing connection, and the API runs the SSH client, so no port needs to be open on the
Pi's network. Log in with a Pi user's password or private key; nothing is stored. Sessions close
after 30 idle minutes, at most 3 per speaker, and each open, close and failed login is written to
that speaker's device log. Serve GramSetu over HTTPS so passwords are encrypted between the browser
and the server.



## Legacy speaker API

Devices that don't run the agent can poll instead:

```http
GET /api/device/poll
X-Device-Id: spk-rampur-school
X-Device-Key: rampur-school-demo-key
```

When a delivery is due, download `delivery.audioUrl` with the same headers, then:

```http
POST /api/device/ack
X-Device-Id: spk-rampur-school
X-Device-Key: rampur-school-demo-key

{ "deliveryId": "..." }
```

