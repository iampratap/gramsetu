import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { LocationPicker } from "../components/LocationPicker.jsx";
import { Badge, Banner, Empty, Field, Modal, PageHead } from "../components/ui.jsx";
import { STATUS_LABEL, formatClock, formatWhen } from "../format.js";
import { useLiveSpeakers, useTicker } from "../live.js";
import { parseCoordinate } from "../map.js";

const blank = {
  name: "",
  location: "",
  deviceId: "",
  status: "OFFLINE",
  notes: "",
  areaId: "",
  isActive: true,
  latitude: "",
  longitude: "",
};

function editable(speaker, extra = {}) {
  return { ...speaker, notes: speaker.notes || "", latitude: speaker.latitude ?? "", longitude: speaker.longitude ?? "", error: "", ...extra };
}

function effectiveStatus(speaker) {
  return speaker.connected ? "ONLINE" : speaker.status;
}

export function Speakers() {
  const { user } = useAuth();
  const global = user.role === "SUPERADMIN" || user.role === "ADMIN";
  const { speakers, reports, connected } = useLiveSpeakers();
  const [areas, setAreas] = useState([]);
  const [audio, setAudio] = useState([]);
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [areaId, setAreaId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const now = useTicker(1000);

  useEffect(() => {
    api("/api/audio?page=1&pageSize=100")
      .then((data) => setAudio(data.audioFiles))
      .catch((err) => setError(err.message));
    if (global) api("/api/areas").then((data) => setAreas(data.areas)).catch(() => {});
  }, [global]);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return speakers.filter((speaker) => {
      if (areaId && speaker.areaId !== areaId) return false;
      if (status && effectiveStatus(speaker) !== status) return false;
      if (!text) return true;
      return [speaker.name, speaker.location, speaker.deviceId, speaker.area?.name].some((value) => value?.toLowerCase().includes(text));
    });
  }, [speakers, query, areaId, status]);

  const online = speakers.filter((speaker) => speaker.connected).length;

  async function openEditor(speaker) {
    setError("");
    try {
      // The live feed leaves out the device key and notes, so fetch the full record.
      const data = await api(`/api/speakers?q=${encodeURIComponent(speaker.deviceId)}`);
      const full = data.speakers.find((item) => item.id === speaker.id);
      if (!full) throw new Error("Speaker not found");
      setForm(editable(full));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="page page-wide">
      <PageHead
        eyebrow="Field"
        title="Speakers"
        lede="Every speaker location with what it is playing right now. Controls only reach speakers that are online; offline speakers keep playing their stored announcements on time."
      >
        <span className={`live-pill${connected ? " on" : ""}`}>
          <span className="live-dot" />
          {connected ? `Live · ${online}/${speakers.length} online` : "Reconnecting…"}
        </span>
        {global ? (
          <button className="btn primary" type="button" onClick={() => setForm({ ...blank, areaId: areaId || areas[0]?.id || "" })}>
            Add speaker
          </button>
        ) : null}
      </PageHead>
      <Banner>{error}</Banner>
      <div className="toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, place, or device id" />
        {global ? (
          <select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">All areas</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>{area.name}</option>
            ))}
          </select>
        ) : null}
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Any status</option>
          <option value="ONLINE">Online</option>
          <option value="OFFLINE">Offline</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="RETIRED">Retired</option>
        </select>
      </div>
      {visible.length === 0 ? (
        <div className="panel">
          <Empty
            title={!connected && speakers.length === 0 ? "Connecting to the live feed" : speakers.length ? "No speakers match" : "No speakers yet"}
            lede={global ? "Add a speaker for each place that should hear announcements." : "Speakers in your area will appear here."}
          />
        </div>
      ) : (
        <div className="speaker-grid">
          {visible.map((speaker) => (
            <SpeakerCard
              key={speaker.id}
              speaker={speaker}
              global={global}
              audio={audio.filter((file) => file.areaId === speaker.areaId)}
              now={now}
              onEdit={() => openEditor(speaker)}
            />
          ))}
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h2>Live activity</h2>
          <span className="muted">Play reports as speakers send them</span>
        </div>
        {reports.length === 0 ? (
          <p className="muted activity-empty">Nothing yet. Finished plays show up here in real time.</p>
        ) : (
          <ul className="activity">
            {reports.map((report) => (
              <li key={report.id}>
                <Badge value={report.result}>{STATUS_LABEL[report.result]}</Badge>
                <span>
                  <strong>{report.title}</strong>
                  <span className="muted"> · {report.speaker?.name} · {STATUS_LABEL[report.source]}</span>
                  {report.playedOffline ? <span className="muted"> · played offline</span> : null}
                  {report.error ? <span className="muted"> · {report.error}</span> : null}
                </span>
                <span className="muted">{formatWhen(report.endedAt || report.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {form ? <SpeakerForm form={form} setForm={setForm} areas={areas} global={global} speakers={speakers} /> : null}
    </section>
  );
}

function SpeakerCard({ speaker, global, audio, now, onEdit }) {
  const state = speaker.state || {};
  const online = speaker.connected;
  const playing = state.status === "playing";
  const nowPlaying = state.nowPlaying;
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [testAudio, setTestAudio] = useState("");

  let position = nowPlaying?.position ?? null;
  if (online && playing && position !== null && speaker.stateAt) {
    position += (now - new Date(speaker.stateAt).getTime()) / 1000;
  }
  const duration = nowPlaying?.duration ?? null;
  if (position !== null && duration) position = Math.min(position, duration);
  const percent = position !== null && duration ? (position / duration) * 100 : 0;

  async function send(action, extra = {}) {
    setBusy(action);
    setMessage(null);
    try {
      const result = await api(`/api/speakers/${speaker.id}/command`, { method: "POST", body: { action, ...extra } });
      setMessage({ ok: true, text: result.message || "Done" });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy("");
    }
  }

  const skew = state.clockSkewSeconds;
  const shown = effectiveStatus(speaker);

  return (
    <article className={`speaker-card${online ? "" : " is-offline"}`}>
      <header>
        <div>
          <strong>{speaker.name}</strong>
          <div className="muted">{speaker.location}{global && speaker.area ? ` · ${speaker.area.name}` : ""}</div>
        </div>
        <div className="speaker-badges">
          <Badge value={shown}>{STATUS_LABEL[shown]}</Badge>
          {online && state.status ? <Badge value={state.status}>{STATUS_LABEL[state.status]}</Badge> : null}
        </div>
      </header>

      <div className="now-playing">
        {nowPlaying ? (
          <>
            <div className="now-title">
              <span>{nowPlaying.title}</span>
              <Badge value={nowPlaying.source}>{STATUS_LABEL[nowPlaying.source]}</Badge>
            </div>
            <div className="progress"><span style={{ width: `${percent}%` }} /></div>
            <div className="muted progress-time">
              <span>{formatClock(position)}</span>
              <span>{formatClock(duration)}</span>
            </div>
          </>
        ) : (
          <p className="muted">{online ? "Nothing playing" : speaker.stateAt ? "Last known: idle" : "Never connected"}</p>
        )}
      </div>

      <dl className="speaker-facts">
        <div><dt>Volume</dt><dd>{state.volume ?? "—"}{state.volume !== undefined ? "%" : ""}</dd></div>
        <div><dt>Queue</dt><dd>{state.queueLength ?? 0}</dd></div>
        <div>
          <dt>Next</dt>
          <dd>{state.nextSchedule ? `${state.nextSchedule.title} · ${formatWhen(state.nextSchedule.at)}` : "—"}</dd>
        </div>
        <div><dt>Unsynced reports</dt><dd>{state.pendingReports ?? 0}</dd></div>
        <div><dt>{online ? "Last sync" : "Last seen"}</dt><dd>{formatWhen(online ? state.lastSyncAt : speaker.lastSeenAt)}</dd></div>
        <div><dt>Device</dt><dd>{speaker.deviceId}{speaker.agentVersion ? ` · v${speaker.agentVersion}` : ""}</dd></div>
      </dl>

      {skew !== null && skew !== undefined && Math.abs(skew) > 60 ? (
        <div className="banner">Clock is off by {Math.round(skew)} s. Timed announcements use the speaker clock.</div>
      ) : null}
      {online && state.lastError ? <div className="banner">{state.lastError}</div> : null}

      <div className="controls">
        {playing ? (
          <button className="btn ghost small" type="button" disabled={!online || busy || state.status === "broadcast"} onClick={() => send("pause")}>Pause</button>
        ) : (
          <button className="btn ghost small" type="button" disabled={!online || busy || state.status === "broadcast"} onClick={() => send("play")}>
            {state.status === "paused" ? "Resume" : "Play"}
          </button>
        )}
        <button className="btn ghost small" type="button" disabled={!online || busy || !nowPlaying} onClick={() => send("skip")}>{state.status === "broadcast" ? "Leave broadcast" : "Skip"}</button>
        <button className="btn ghost small" type="button" disabled={!online || busy} onClick={() => send("stop")}>Stop</button>
        <span className="control-gap" />
        <button className="btn ghost small" type="button" aria-label="Volume down" disabled={!online || busy} onClick={() => send("volume_down")}>Vol −</button>
        <button className="btn ghost small" type="button" aria-label="Volume up" disabled={!online || busy} onClick={() => send("volume_up")}>Vol +</button>
      </div>

      <div className="live-test">
        <select value={testAudio} onChange={(event) => setTestAudio(event.target.value)} disabled={!online}>
          <option value="">Live test: choose audio</option>
          {audio.map((file) => (
            <option key={file.id} value={file.id}>{file.title}</option>
          ))}
        </select>
        <button
          className="btn primary small"
          type="button"
          disabled={!online || !testAudio || busy}
          onClick={() => send("play_audio", { audioFileId: testAudio })}
        >
          {busy === "play_audio" ? "Sending…" : "Play now"}
        </button>
      </div>

      {message ? <p className={`card-message${message.ok ? " ok" : ""}`}>{message.text}</p> : null}

      {global ? (
        <div className="card-tools">
          <button className="btn ghost small" type="button" onClick={onEdit}>Edit &amp; setup</button>
          <Link className="btn ghost small" to={`/device-logs?speaker=${speaker.id}`}>Logs</Link>
          {online ? (
            <Link className="btn ghost small" to={`/remote-shell?speaker=${speaker.id}`}>Remote shell</Link>
          ) : (
            <span className="btn ghost small" aria-disabled="true">Remote shell</span>
          )}
        </div>
      ) : null}
    </article>
  );
}

const SIM_NETWORKS = [
  ["", "No SIM (Wi-Fi / Ethernet)"],
  ["airtel", "Airtel"],
  ["jio", "Jio"],
  ["vi", "Vi"],
  ["bsnl", "BSNL"],
];

function SetupCommand({ deviceId, deviceKey }) {
  const [copied, setCopied] = useState(false);
  const [network, setNetwork] = useState("");
  const origin = window.location.origin;
  const command = [
    `curl -fsSL ${origin}/downloads/gramsetu-speaker.tar.gz | tar xz`,
    `cd gramsetu-speaker && sudo ./setup.sh --server ${origin} --device-id ${deviceId} --device-key ${deviceKey}${network ? ` --network ${network}` : ""}`,
  ].join("\n");

  return (
    <div className="setup-command">
      <div className="setup-command-head">
        <span>Raspberry Pi setup</span>
        <select value={network} onChange={(event) => setNetwork(event.target.value)} aria-label="SIM network">
          {SIM_NETWORKS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button
          className="btn ghost small"
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{command}</pre>
      <small className="muted">
        Run on the Pi (Raspberry Pi OS Lite) while it has internet over Wi-Fi or Ethernet; with a SIM network chosen it also sets up the
        4G modem to connect on boot. Rolling the device key disconnects the speaker until setup is run again.
      </small>
    </div>
  );
}

function SpeakerForm({ form, setForm, areas, global, speakers }) {
  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const areaCenter = useMemo(() => {
    const placed = speakers.filter((item) => item.areaId === form.areaId && item.latitude !== null && item.longitude !== null);
    if (!placed.length) return null;
    return [
      placed.reduce((sum, item) => sum + item.latitude, 0) / placed.length,
      placed.reduce((sum, item) => sum + item.longitude, 0) / placed.length,
    ];
  }, [speakers, form.areaId]);

  async function save(event) {
    event.preventDefault();
    const latitude = parseCoordinate(form.latitude, 90);
    const longitude = parseCoordinate(form.longitude, 180);
    const typedLat = String(form.latitude ?? "").trim() !== "";
    const typedLng = String(form.longitude ?? "").trim() !== "";
    if ((typedLat && latitude === null) || (typedLng && longitude === null)) {
      update("error", "Latitude must be between -90 and 90 and longitude between -180 and 180.");
      return;
    }
    if ((latitude === null) !== (longitude === null)) {
      update("error", "Give both latitude and longitude, or clear both.");
      return;
    }
    const payload = {
      name: form.name,
      location: form.location,
      deviceId: form.deviceId,
      status: form.status,
      notes: form.notes,
      areaId: form.areaId,
      isActive: form.isActive,
      latitude,
      longitude,
    };
    try {
      if (form.id) {
        await api(`/api/speakers/${form.id}`, { method: "PATCH", body: payload });
        setForm(null);
      } else {
        // Keep the dialog open on the new speaker so its setup command can be copied.
        const data = await api("/api/speakers", { method: "POST", body: payload });
        setForm(editable(data.speaker, { created: true }));
      }
    } catch (err) {
      update("error", err.message);
    }
  }

  async function rollKey() {
    if (!window.confirm("Make a new device key? The speaker disconnects until setup is run again with the new key.")) return;
    try {
      const data = await api(`/api/speakers/${form.id}/roll-key`, { method: "POST" });
      setForm(editable(data.speaker));
    } catch (err) {
      update("error", err.message);
    }
  }

  return (
    <Modal
      title={form.created ? "Speaker added" : form.id ? "Edit speaker" : "New speaker"}
      lede={form.created ? "Run the setup command below on the speaker's Raspberry Pi." : "The device id and key are what the speaker uses to connect."}
      onClose={() => setForm(null)}
    >
      <form className="stack" onSubmit={save}>
        <Banner>{form.error}</Banner>
        {global ? (
          <Field label="Area">
            <select value={form.areaId || ""} onChange={(event) => update("areaId", event.target.value)} required>
              <option value="">Choose an area</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>{area.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        <div className="split-fields">
          <Field label="Name">
            <input value={form.name} onChange={(event) => update("name", event.target.value)} required />
          </Field>
          <Field label="Location">
            <input value={form.location} onChange={(event) => update("location", event.target.value)} required />
          </Field>
        </div>
        <Field label="Map position" hint="Shown on the Map page.">
          <LocationPicker
            latitude={form.latitude}
            longitude={form.longitude}
            fallbackCenter={areaCenter}
            onChange={(latitude, longitude) => setForm((current) => ({ ...current, latitude, longitude }))}
          />
        </Field>
        <Field label="Device id" hint={form.id ? undefined : "Leave blank to generate one."}>
          <input value={form.deviceId || ""} onChange={(event) => update("deviceId", event.target.value)} />
        </Field>
        <Field label="Status" hint="Online and offline are set automatically while the speaker is connected.">
          <select value={form.status} onChange={(event) => update("status", event.target.value)}>
            <option value="OFFLINE">Offline</option>
            <option value="ONLINE">Online</option>
            <option value="MAINTENANCE">Maintenance</option>
          </select>
        </Field>
        <Field label="Notes">
          <textarea rows="3" value={form.notes || ""} onChange={(event) => update("notes", event.target.value)} />
        </Field>
        {form.id ? (
          <label className="check">
            <input type="checkbox" checked={form.isActive} onChange={(event) => update("isActive", event.target.checked)} />
            Speaker is installed and in service
          </label>
        ) : null}
        {form.deviceKey ? (
          <>
            <p className="credential">Device key <code>{form.deviceKey}</code></p>
            <SetupCommand deviceId={form.deviceId} deviceKey={form.deviceKey} />
          </>
        ) : null}
        <div className="form-actions">
          {form.id ? (
            <button className="btn ghost" type="button" onClick={rollKey}>Roll device key</button>
          ) : null}
          <button className="btn primary" type="submit">{form.created ? "Save changes" : "Save speaker"}</button>
        </div>
      </form>
    </Modal>
  );
}
