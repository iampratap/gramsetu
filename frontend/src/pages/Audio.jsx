import { useEffect, useState } from "react";
import { api, audioUrl } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Banner, Empty, Field, Modal, PageHead, Pagination } from "../components/ui.jsx";
import { formatBytes, formatWhen, useDebounced } from "../format.js";

const PAGE_SIZE = 10;

export function AudioLibrary() {
  const { user } = useAuth();
  const canUpload = user.role === "MAKER" || user.role === "SUPERADMIN" || user.role === "ADMIN";
  const canDelete = user.role === "MAKER" || user.role === "SUPERADMIN" || user.role === "ADMIN";
  const global = user.role === "SUPERADMIN" || user.role === "ADMIN";
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [areas, setAreas] = useState([]);
  const [query, setQuery] = useState("");
  const [areaId, setAreaId] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(null);
  const [form, setForm] = useState(null);
  const debounced = useDebounced(query);

  async function load(nextPage = page) {
    const params = new URLSearchParams();
    if (debounced) params.set("q", debounced);
    if (areaId) params.set("areaId", areaId);
    params.set("page", String(nextPage));
    params.set("pageSize", String(PAGE_SIZE));
    try {
      const data = await api(`/api/audio?${params.toString()}`);
      const nextMeta = data.meta;
      if (data.audioFiles.length === 0 && nextMeta.page > 1) {
        setPage(nextMeta.page - 1);
        return;
      }
      setRows(data.audioFiles);
      setMeta(nextMeta);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [debounced, areaId]);

  useEffect(() => {
    load(page);
  }, [debounced, areaId, page]);

  useEffect(() => {
    if (!global) return;
    api("/api/areas").then((data) => setAreas(data.areas.filter((area) => area.isActive))).catch(() => {});
  }, [global]);

  async function save(event) {
    event.preventDefault();
    const body = new FormData();
    body.set("title", form.title);
    body.set("description", form.description || "");
    if (global) body.set("areaId", form.areaId);
    body.set("file", form.file);
    try {
      await api("/api/audio", { method: "POST", form: body });
      setForm(null);
      setPage(1);
      await load(1);
    } catch (err) {
      setForm((current) => ({ ...current, error: err.message }));
    }
  }

  async function remove(file) {
    if (!window.confirm(`Delete “${file.title}” from the collection?`)) return;
    try {
      await api(`/api/audio/${file.id}`, { method: "DELETE" });
      if (playing === file.id) setPlaying(null);
      await load(page);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="page">
      <PageHead
        eyebrow="Field"
        title="Audio library"
        lede="Makers upload audio. The app converts it to 16 kHz 16-bit mono WAV, stores it in S3, and keeps the metadata here."
      >
        {canUpload ? (
          <button className="btn primary" type="button" onClick={() => setForm({ title: "", description: "", areaId: areaId || areas[0]?.id || "", file: null })}>
            Upload audio
          </button>
        ) : null}
      </PageHead>
      <Banner>{error}</Banner>
      <div className="toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles"
        />
        {global ? (
          <select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">All areas</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>{area.name}</option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="stack">
        {rows.length === 0 ? (
          <div className="panel"><Empty title="No audio yet" lede="Upload a notice, a meeting reminder, or any message the village should hear." /></div>
        ) : rows.map((file) => (
          <article key={file.id} className="audio-card">
            <div>
              <strong>{file.title}</strong>
              <p className="muted">
                {file.area?.name} · {formatBytes(file.sizeBytes)} · {file.sampleRate / 1000} kHz {file.bitDepth}-bit mono · {file.uploadedBy?.name} · {formatWhen(file.createdAt)}
              </p>
              {file.description ? <p>{file.description}</p> : null}
              {playing === file.id ? <audio controls autoPlay src={audioUrl(file.id)} /> : null}
            </div>
            <div className="row-actions">
              <button className="btn ghost small" type="button" onClick={() => setPlaying(playing === file.id ? null : file.id)}>
                {playing === file.id ? "Hide player" : "Play"}
              </button>
              <a className="btn ghost small" href={audioUrl(file.id, true)}>Download</a>
              {canDelete ? (
                <button className="btn danger small" type="button" onClick={() => remove(file)}>Delete</button>
              ) : null}
            </div>
          </article>
        ))}
        <Pagination meta={meta} onPageChange={setPage} />
      </div>
      {form ? (
        <Modal
          title="Upload audio"
          lede="Any common audio format works. GramSetu normalizes it to 16 kHz 16-bit mono WAV before saving to S3."
          onClose={() => setForm(null)}
        >
          <form className="stack" onSubmit={save}>
            <Banner>{form.error}</Banner>
            <Field label="Title">
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
            </Field>
            {global ? (
              <Field label="Area">
                <select value={form.areaId} onChange={(event) => setForm({ ...form, areaId: event.target.value })} required>
                  <option value="">Choose an area</option>
                  {areas.map((area) => (
                    <option key={area.id} value={area.id}>{area.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Description">
              <textarea rows="3" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
            <Field label="Audio file" hint="mp3, wav, ogg, m4a, or aac. Up to 25 MB.">
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac"
                required
                onChange={(event) => setForm({ ...form, file: event.target.files?.[0] || null })}
              />
            </Field>
            <button className="btn primary" type="submit">Normalize and save</button>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
