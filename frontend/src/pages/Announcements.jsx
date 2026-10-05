import { useEffect, useState } from "react";
import { api, audioUrl } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Badge, Banner, Empty, Field, Modal, PageHead, Pagination } from "../components/ui.jsx";
import { STATUS_LABEL, WEEKDAYS, describePlan, formatWhen, useDebounced } from "../format.js";

const PAGE_SIZE = 10;
const PLAN_OPTIONS = [
  ["NOW", "Right after approval"],
  ["ONCE", "Once"],
  ["DAILY", "Daily"],
  ["WEEKLY", "Weekly"],
];

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function permissions(user) {
  const global = user.role === "SUPERADMIN" || user.role === "ADMIN";
  return {
    global,
    canCreate: global || user.role === "MAKER",
    canEdit: (item) => global || (user.role === "MAKER" && item.areaId === user.areaId),
    canReview: (item) =>
      item.status === "PENDING" && (global || (user.role === "CHECKER" && item.areaId === user.areaId && item.createdBy?.id !== user.id)),
    canPause: (item) => item.status === "APPROVED" && item.repeat !== "NOW" && (global || user.role === "MAKER" || user.role === "CHECKER"),
  };
}

function statusBadge(item) {
  if (item.status === "APPROVED" && !item.isActive) return <Badge value="inactive">Paused</Badge>;
  return <Badge value={item.status}>{STATUS_LABEL[item.status]}</Badge>;
}

export function Announcements() {
  const { user } = useAuth();
  const can = permissions(user);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(user.role === "CHECKER" ? "PENDING" : "");
  const [plays, setPlays] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [active, setActive] = useState(null);
  const debounced = useDebounced(query);

  async function load(nextPage = page) {
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
    if (debounced) params.set("q", debounced);
    if (status) params.set("status", status);
    if (plays) params.set("plays", plays);
    if (areaId) params.set("areaId", areaId);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    try {
      const data = await api(`/api/announcements?${params.toString()}`);
      if (data.announcements.length === 0 && data.meta.page > 1) {
        setPage(data.meta.page - 1);
        return;
      }
      setRows(data.announcements);
      setMeta(data.meta);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [debounced, status, plays, areaId, fromDate, toDate]);

  useEffect(() => {
    load(page);
  }, [debounced, status, plays, areaId, fromDate, toDate, page]);

  useEffect(() => {
    if (can.global) api("/api/areas").then((data) => setAreas(data.areas.filter((area) => area.isActive))).catch(() => {});
  }, [can.global]);

  async function setPaused(item, paused) {
    try {
      await api(`/api/announcements/${item.id}/active`, { method: "POST", body: { isActive: !paused } });
      await load(page);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(item) {
    if (!window.confirm(`Delete “${item.title}”? Speakers stop playing it after their next sync.`)) return;
    try {
      await api(`/api/announcements/${item.id}`, { method: "DELETE" });
      await load(page);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="page">
      <PageHead
        eyebrow="Field"
        title="Announcements"
        lede="Play audio right after approval, once at a set time, or every day or week. A maker submits, a checker in the same area approves or rejects, and admins can do both. Speakers store approved announcements and play them on time even when offline."
      >
        {can.canCreate ? (
          <button className="btn primary" type="button" onClick={() => setEditing({})}>New announcement</button>
        ) : null}
      </PageHead>
      <Banner>{error}</Banner>
      <div className="toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search announcements" />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending review</option>
          <option value="APPROVED">Approved</option>
          <option value="PAUSED">Paused</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select value={plays} onChange={(event) => setPlays(event.target.value)}>
          <option value="">Any timing</option>
          <option value="now">Right after approval</option>
          <option value="scheduled">Scheduled</option>
        </select>
        {can.global ? (
          <select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">All areas</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>{area.name}</option>
            ))}
          </select>
        ) : null}
        <div className="date-pair">
          <label className="date-field">
            <span>From</span>
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
          </label>
          <label className="date-field">
            <span>To</span>
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} />
          </label>
          {fromDate || toDate ? (
            <button
              className="btn ghost small"
              type="button"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              Clear dates
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <Empty
            title="Nothing here yet"
            lede={can.canCreate ? "Create an announcement to play it on your speakers." : "Announcements for your area will show up here."}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Announcement</th>
                  <th>Plays</th>
                  <th>Speakers</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <div className="muted">
                        {item.audioFile?.title} · {item.createdBy?.name}
                        {can.global ? ` · ${item.area?.name}` : ""}
                      </div>
                    </td>
                    <td>
                      {describePlan(item)}
                      <div className="muted">{item.repeat === "NOW" ? `Created ${formatWhen(item.createdAt)}` : item.timezone}</div>
                    </td>
                    <td>{item.deliveries.map((delivery) => delivery.speaker.name).join(", ") || "—"}</td>
                    <td>{statusBadge(item)}</td>
                    <td className="row-actions">
                      <button className={`btn small ${can.canReview(item) ? "primary" : "ghost"}`} type="button" onClick={() => setActive(item)}>
                        {can.canReview(item) ? "Review" : "Open"}
                      </button>
                      {can.canEdit(item) ? (
                        <button className="btn ghost small" type="button" onClick={() => setEditing(item)}>Edit</button>
                      ) : null}
                      {can.canPause(item) ? (
                        <button className="btn ghost small" type="button" onClick={() => setPaused(item, item.isActive)}>
                          {item.isActive ? "Pause" : "Resume"}
                        </button>
                      ) : null}
                      {can.canEdit(item) ? (
                        <button className="btn danger small" type="button" onClick={() => remove(item)}>Delete</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination meta={meta} onPageChange={setPage} />
      {editing ? (
        <AnnouncementForm
          item={editing}
          global={can.global}
          areas={areas}
          defaultAreaId={areaId || user.areaId || areas[0]?.id || ""}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const wasNew = !editing.id;
            setEditing(null);
            if (wasNew) setPage(1);
            await load(wasNew ? 1 : page);
          }}
        />
      ) : null}
      {active ? (
        <Review
          item={active}
          canReview={can.canReview(active)}
          onClose={() => setActive(null)}
          onDone={async () => {
            setActive(null);
            await load(page);
          }}
        />
      ) : null}
    </section>
  );
}

function AnnouncementForm({ item, global, areas, defaultAreaId, onClose, onSaved }) {
  const editing = Boolean(item.id);
  const [areaId, setAreaId] = useState(item.areaId || defaultAreaId);
  const [title, setTitle] = useState(item.title || "");
  const [notes, setNotes] = useState(item.notes || "");
  const [mode, setMode] = useState("library");
  const [audioFileId, setAudioFileId] = useState(item.audioFileId || "");
  const [audioTitle, setAudioTitle] = useState("");
  const [file, setFile] = useState(null);
  const [speakerIds, setSpeakerIds] = useState(item.deliveries?.map((delivery) => delivery.speaker.id) || []);
  const [repeat, setRepeat] = useState(item.repeat || "NOW");
  const [startDate, setStartDate] = useState(item.startDate || today());
  const [endDate, setEndDate] = useState(item.endDate || "");
  const [times, setTimes] = useState(item.times?.length ? item.times : ["08:00"]);
  const [days, setDays] = useState(item.daysOfWeek?.length ? item.daysOfWeek : [1, 2, 3, 4, 5]);
  const [timezone, setTimezone] = useState(item.timezone || "Asia/Kolkata");
  const [approve, setApprove] = useState(global);
  const [audio, setAudio] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!areaId) return;
    const scope = global ? `areaId=${areaId}` : "";
    Promise.all([api(`/api/audio?page=1&pageSize=50&${scope}`), api(`/api/speakers?${scope}`)])
      .then(([audioData, speakerData]) => {
        setAudio(audioData.audioFiles);
        setSpeakers(speakerData.speakers.filter((speaker) => speaker.isActive));
        if (audioData.audioFiles.length === 0) setMode("upload");
      })
      .catch((err) => setError(err.message));
  }, [areaId, global]);

  function changeArea(next) {
    setAreaId(next);
    setAudioFileId("");
    setSpeakerIds([]);
  }

  function toggle(list, setList, value) {
    setList(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  }

  async function submit(event) {
    event.preventDefault();
    if (speakerIds.length === 0) {
      setError("Choose at least one speaker");
      return;
    }
    const body = new FormData();
    if (global) body.set("areaId", areaId);
    body.set("title", title);
    body.set("notes", notes);
    body.set("speakerIds", JSON.stringify(speakerIds));
    body.set("repeat", repeat);
    if (repeat !== "NOW") {
      body.set("startDate", startDate);
      if (repeat !== "ONCE" && endDate) body.set("endDate", endDate);
      body.set("times", JSON.stringify(times.filter(Boolean)));
      if (repeat === "WEEKLY") body.set("daysOfWeek", JSON.stringify(days));
      body.set("timezone", timezone);
    }
    if (global) body.set("approve", String(approve));
    if (mode === "upload") {
      if (!file) {
        setError("Choose an audio file");
        return;
      }
      body.set("file", file);
      body.set("audioTitle", audioTitle || file.name);
    } else if (!audioFileId) {
      setError("Choose an audio file from the collection");
      return;
    } else {
      body.set("audioFileId", audioFileId);
    }
    setSaving(true);
    setError("");
    try {
      await api(editing ? `/api/announcements/${item.id}` : "/api/announcements", { method: editing ? "PUT" : "POST", form: body });
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const lede = global
    ? "As an admin you can approve it straight away, or leave it for a checker."
    : editing
      ? "Saving sends it back to a checker; speakers stop playing it until it is approved again."
      : "This stays pending until a checker in your area approves it.";

  return (
    <Modal title={editing ? "Edit announcement" : "New announcement"} lede={lede} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Banner>{error}</Banner>
        {global ? (
          <Field label="Area">
            <select value={areaId} onChange={(event) => changeArea(event.target.value)} required>
              <option value="">Choose an area</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>{area.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} required />
        </Field>
        <Field label="Notes for the checker">
          <textarea rows="2" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <div className="segmented">
          <button type="button" className={mode === "library" ? "on" : ""} onClick={() => setMode("library")}>Existing audio</button>
          <button type="button" className={mode === "upload" ? "on" : ""} onClick={() => setMode("upload")}>Upload new</button>
        </div>
        {mode === "library" ? (
          <Field label="Collection">
            <select value={audioFileId} onChange={(event) => setAudioFileId(event.target.value)} required>
              <option value="">Choose audio</option>
              {audio.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.title}</option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Title in the collection">
              <input value={audioTitle} onChange={(event) => setAudioTitle(event.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Audio file" hint="Converted to 16 kHz mono WAV.">
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </Field>
          </>
        )}
        <fieldset className="speaker-picks">
          <legend>Speakers</legend>
          {speakers.length === 0 ? (
            <p className="muted">No active speakers in this area.</p>
          ) : (
            speakers.map((speaker) => (
              <label key={speaker.id} className="check">
                <input type="checkbox" checked={speakerIds.includes(speaker.id)} onChange={() => toggle(speakerIds, setSpeakerIds, speaker.id)} />
                <span>
                  <strong>{speaker.name}</strong>
                  <small>{speaker.location}</small>
                </span>
              </label>
            ))
          )}
        </fieldset>
        <Field label="When to play">
          <div className="segmented">
            {PLAN_OPTIONS.map(([value, label]) => (
              <button key={value} type="button" className={repeat === value ? "on" : ""} onClick={() => setRepeat(value)}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        {repeat === "WEEKLY" ? (
          <div className="weekday-picks" role="group" aria-label="Weekdays">
            {WEEKDAYS.map((label, index) => (
              <button key={label} type="button" className={days.includes(index) ? "on" : ""} onClick={() => toggle(days, setDays, index)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {repeat !== "NOW" ? (
          <>
            <div className="split-fields">
              <Field label={repeat === "ONCE" ? "Date" : "Start date"}>
                <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
              </Field>
              {repeat !== "ONCE" ? (
                <Field label="End date" hint="Optional">
                  <input type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} />
                </Field>
              ) : null}
            </div>
            <Field label="Play times">
              <div className="time-list">
                {times.map((time, index) => (
                  <span key={index} className="time-item">
                    <input
                      type="time"
                      value={time}
                      required
                      onChange={(event) => setTimes(times.map((entry, position) => (position === index ? event.target.value : entry)))}
                    />
                    {times.length > 1 ? (
                      <button className="btn ghost small" type="button" aria-label="Remove time" onClick={() => setTimes(times.filter((_, position) => position !== index))}>×</button>
                    ) : null}
                  </span>
                ))}
                <button className="btn ghost small" type="button" onClick={() => setTimes([...times, "12:00"])}>Add time</button>
              </div>
            </Field>
            <Field label="Timezone" hint="Times are played in this timezone.">
              <input value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
            </Field>
          </>
        ) : null}
        {global ? (
          <label className="check">
            <input type="checkbox" checked={approve} onChange={(event) => setApprove(event.target.checked)} />
            Approve now (otherwise it waits for a checker)
          </label>
        ) : null}
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : global && approve ? "Save and approve" : "Submit for review"}
        </button>
      </form>
    </Modal>
  );
}

function Review({ item, canReview, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function decide(decision) {
    if (decision === "REJECTED" && !note.trim()) {
      setError("Add a note explaining the rejection");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/api/announcements/${item.id}/review`, { method: "POST", body: { decision, note } });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal title={item.title} lede={`${item.area?.name || "Area"} · by ${item.createdBy?.name || "Maker"} · ${formatWhen(item.createdAt)}`} onClose={onClose}>
      <div className="stack">
        <Banner>{error}</Banner>
        <p>
          {statusBadge(item)} <strong>{describePlan(item)}</strong>
          {item.repeat !== "NOW" ? <span className="muted"> · {item.timezone}</span> : null}
        </p>
        {item.notes ? <p>{item.notes}</p> : null}
        <audio controls src={audioUrl(item.audioFile.id)} />
        <div className="delivery-list">
          {item.deliveries.map((delivery) => (
            <div key={delivery.id}>
              <strong>{delivery.speaker.name}</strong>
              <span>{delivery.speaker.location}</span>
              <Badge value={delivery.status}>{STATUS_LABEL[delivery.status]}</Badge>
            </div>
          ))}
        </div>
        {item.reviewNote ? <p className="muted">Review note: {item.reviewNote}</p> : null}
        {item.reviewedAt ? <p className="muted">Reviewed {formatWhen(item.reviewedAt)} by {item.reviewedBy?.name || "the system"}</p> : null}
        {canReview ? (
          <>
            <Field label="Review note" hint="Required if you reject.">
              <textarea rows="3" value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <div className="form-actions">
              <button className="btn danger" type="button" disabled={saving} onClick={() => decide("REJECTED")}>Reject</button>
              <button className="btn primary" type="button" disabled={saving} onClick={() => decide("APPROVED")}>Approve</button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
