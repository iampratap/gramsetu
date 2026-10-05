import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Banner, Empty, Field, Modal, PageHead } from "../components/ui.jsx";
import { useDebounced } from "../format.js";

const blank = {
  name: "",
  code: "",
  district: "",
  state: "",
  description: "",
  isActive: true,
};

export function Areas() {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const debounced = useDebounced(query);

  async function load() {
    const params = new URLSearchParams();
    if (debounced) params.set("q", debounced);
    try {
      const data = await api(`/api/areas?${params.toString()}`);
      setRows(data.areas);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [debounced]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event) {
    event.preventDefault();
    const payload = {
      name: form.name,
      code: form.code,
      district: form.district,
      state: form.state,
      description: form.description,
      isActive: form.isActive,
    };
    try {
      if (form.id) await api(`/api/areas/${form.id}`, { method: "PATCH", body: payload });
      else await api("/api/areas", { method: "POST", body: payload });
      setForm(null);
      await load();
    } catch (err) {
      update("error", err.message);
    }
  }

  return (
    <section className="page">
      <PageHead eyebrow="Masters" title="Areas" lede="Each area is a village or locality. Speakers, audio, and announcements stay inside it.">
        <button className="btn primary" type="button" onClick={() => setForm({ ...blank })}>Add area</button>
      </PageHead>
      <Banner>{error}</Banner>
      <div className="toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search area, code, or district" />
      </div>
      <div className="panel">
        {rows.length === 0 ? <Empty title="No areas yet" lede="Add the first village to start installing speakers." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>District</th>
                  <th>Speakers</th>
                  <th>People</th>
                  <th>Audio</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((area) => (
                  <tr key={area.id}>
                    <td>
                      <strong>{area.name}</strong>
                      <div className="muted">{area.code}</div>
                    </td>
                    <td>{area.district}, {area.state}</td>
                    <td>{area._count.speakers}</td>
                    <td>{area._count.users}</td>
                    <td>{area._count.audioFiles}</td>
                    <td><Badge value={area.isActive ? "online" : "retired"}>{area.isActive ? "Active" : "Inactive"}</Badge></td>
                    <td className="row-actions">
                      <button className="btn ghost small" type="button" onClick={() => setForm({ ...area, description: area.description || "", error: "" })}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {form ? (
        <Modal title={form.id ? "Edit area" : "New area"} onClose={() => setForm(null)}>
          <form className="stack" onSubmit={save}>
            <Banner>{form.error}</Banner>
            <div className="split-fields">
              <Field label="Village / area name">
                <input value={form.name} onChange={(event) => update("name", event.target.value)} required />
              </Field>
              <Field label="Code" hint="Short unique code, such as RAMPUR.">
                <input value={form.code} onChange={(event) => update("code", event.target.value)} required />
              </Field>
            </div>
            <div className="split-fields">
              <Field label="District">
                <input value={form.district} onChange={(event) => update("district", event.target.value)} required />
              </Field>
              <Field label="State">
                <input value={form.state} onChange={(event) => update("state", event.target.value)} required />
              </Field>
            </div>
            <Field label="Notes">
              <textarea rows="3" value={form.description} onChange={(event) => update("description", event.target.value)} />
            </Field>
            {form.id ? (
              <label className="check">
                <input type="checkbox" checked={form.isActive} onChange={(event) => update("isActive", event.target.checked)} />
                Area is active
              </label>
            ) : null}
            <button className="btn primary" type="submit">Save area</button>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
