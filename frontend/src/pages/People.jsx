import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Badge, Banner, Empty, Field, Modal, PageHead, Pagination } from "../components/ui.jsx";
import { ROLE_LABEL, useDebounced } from "../format.js";

const PAGE_SIZE = 10;

const COPY = {
  admins: {
    eyebrow: "Masters",
    title: "Platform admins",
    lede: "Admins manage villages, speakers, and the maker and checker for each area. Only a super admin can add them.",
    fixedRole: "ADMIN",
    showArea: false,
    role: "ADMIN",
  },
  users: {
    eyebrow: "Masters",
    title: "Makers and checkers",
    lede: "Makers upload and draft announcements. Checkers approve or reject them before a speaker plays anything.",
    roleChoices: ["MAKER", "CHECKER"],
    showArea: true,
    role: "",
  },
};

const blank = {
  name: "",
  email: "",
  password: "",
  role: "MAKER",
  areaId: "",
  isActive: true,
};

export function PeoplePage({ mode }) {
  const config = COPY[mode];
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [areas, setAreas] = useState([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState(config.role || "");
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const debounced = useDebounced(query);

  useEffect(() => {
    setRoleFilter(COPY[mode].role || "");
    setQuery("");
    setPage(1);
  }, [mode]);

  useEffect(() => {
    setPage(1);
  }, [debounced, roleFilter]);

  async function load(nextPage = page) {
    const params = new URLSearchParams();
    const role = config.roleChoices ? roleFilter : config.role;
    if (role) params.set("role", role);
    if (debounced) params.set("q", debounced);
    params.set("page", String(nextPage));
    params.set("pageSize", String(PAGE_SIZE));
    const data = await api(`/api/users?${params.toString()}`);
    if (data.users.length === 0 && data.meta.page > 1) {
      setPage(data.meta.page - 1);
      return;
    }
    setRows(data.users);
    setMeta(data.meta);
  }

  useEffect(() => {
    api(`/api/users?${(() => {
      const params = new URLSearchParams();
      const role = config.roleChoices ? roleFilter : config.role;
      if (role) params.set("role", role);
      if (debounced) params.set("q", debounced);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      return params.toString();
    })()}`)
      .then((data) => {
        if (data.users.length === 0 && data.meta.page > 1) {
          setPage(data.meta.page - 1);
          return;
        }
        setRows(data.users);
        setMeta(data.meta);
        setError("");
      })
      .catch((err) => setError(err.message));
  }, [debounced, roleFilter, mode, config.role, config.roleChoices, user.role, page]);

  useEffect(() => {
    if (!config.showArea) return;
    api("/api/areas").then((data) => setAreas(data.areas.filter((area) => area.isActive))).catch(() => {});
  }, [config.showArea]);

  function openCreate() {
    setForm({
      ...blank,
      role: config.fixedRole || "MAKER",
      areaId: areas[0]?.id || "",
    });
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event) {
    event.preventDefault();
    const payload = {
      name: form.name,
      email: form.email,
      role: config.fixedRole || form.role,
      isActive: form.isActive,
      areaId: config.showArea ? form.areaId : "",
    };
    if (form.password) payload.password = form.password;
    try {
      if (form.id) await api(`/api/users/${form.id}`, { method: "PATCH", body: payload });
      else await api("/api/users", { method: "POST", body: payload });
      setForm(null);
      if (!form.id) setPage(1);
      await load(form.id ? page : 1);
    } catch (err) {
      update("error", err.message);
    }
  }

  return (
    <section className="page">
      <PageHead eyebrow={config.eyebrow} title={config.title} lede={config.lede}>
        <button className="btn primary" type="button" onClick={openCreate}>Add</button>
      </PageHead>
      <Banner>{error}</Banner>
      <div className="toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email" />
        {config.roleChoices ? (
          <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="">Makers and checkers</option>
            {config.roleChoices.map((role) => (
              <option key={role} value={role}>{ROLE_LABEL[role]}</option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="panel">
        {rows.length === 0 ? <Empty title="No people yet" lede="Add the first account for this list." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  {config.showArea ? <th>Area</th> : null}
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.name}</strong>
                      <div className="muted">{row.email}</div>
                    </td>
                    <td>{ROLE_LABEL[row.role]}</td>
                    {config.showArea ? <td>{row.area?.name || "—"}</td> : null}
                    <td><Badge value={row.isActive ? "online" : "retired"}>{row.isActive ? "Active" : "Inactive"}</Badge></td>
                    <td className="row-actions">
                      <button
                        className="btn ghost small"
                        type="button"
                        onClick={() => setForm({ ...row, password: "", error: "" })}
                      >
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
      <Pagination meta={meta} onPageChange={setPage} />
      {form ? (
        <Modal title={form.id ? "Edit account" : "New account"} onClose={() => setForm(null)}>
          <form onSubmit={save} className="stack">
            <Banner>{form.error}</Banner>
            <Field label="Name">
              <input value={form.name} onChange={(event) => update("name", event.target.value)} required />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} required />
            </Field>
            <Field label={form.id ? "New password" : "Password"} hint={form.id ? "Leave blank to keep the current password." : "At least 8 characters."}>
              <input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} required={!form.id} />
            </Field>
            {config.roleChoices ? (
              <Field label="Role">
                <select value={form.role} onChange={(event) => update("role", event.target.value)}>
                  {config.roleChoices.map((role) => (
                    <option key={role} value={role}>{ROLE_LABEL[role]}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {config.showArea ? (
              <Field label="Area">
                <select value={form.areaId || ""} onChange={(event) => update("areaId", event.target.value)} required>
                  <option value="">Choose an area</option>
                  {areas.map((area) => (
                    <option key={area.id} value={area.id}>{area.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {form.id ? (
              <label className="check">
                <input type="checkbox" checked={form.isActive} onChange={(event) => update("isActive", event.target.checked)} />
                Account is active
              </label>
            ) : null}
            <button className="btn primary" type="submit">Save</button>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
