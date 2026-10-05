import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Badge, Banner, Empty, PageHead, Pagination } from "../components/ui.jsx";
import { STATUS_LABEL, formatDuration, formatWhen } from "../format.js";

const PAGE_SIZE = 20;

export function Reports() {
  const { user } = useAuth();
  const global = user.role === "SUPERADMIN" || user.role === "ADMIN";
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [speakers, setSpeakers] = useState([]);
  const [filters, setFilters] = useState({ speakerId: "", source: "", result: "", from: "", to: "", offline: false });
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/speakers").then((data) => setSpeakers(data.speakers)).catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    for (const [key, value] of Object.entries(filters)) {
      if (value === true) params.set(key, "true");
      else if (value) params.set(key, value);
    }
    api(`/api/reports?${params.toString()}`)
      .then((data) => {
        setRows(data.reports);
        setMeta(data.meta);
        setError("");
      })
      .catch((err) => setError(err.message));
  }, [filters, page]);

  function update(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="page">
      <PageHead
        eyebrow="Field"
        title="Play reports"
        lede="Every play a speaker finishes, skips, or fails. Speakers keep reports locally while offline and upload them when they reconnect."
      />
      <Banner>{error}</Banner>
      <div className="toolbar">
        <select value={filters.speakerId} onChange={(event) => update("speakerId", event.target.value)}>
          <option value="">All speakers</option>
          {speakers.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>{speaker.name}{global ? ` (${speaker.area?.name})` : ""}</option>
          ))}
        </select>
        <select value={filters.source} onChange={(event) => update("source", event.target.value)}>
          <option value="">All sources</option>
          <option value="SCHEDULE">Scheduled announcement</option>
          <option value="ANNOUNCEMENT">Announcement (right after approval)</option>
          <option value="LIVE_TEST">Live test</option>
          <option value="BROADCAST">Live broadcast</option>
        </select>
        <select value={filters.result} onChange={(event) => update("result", event.target.value)}>
          <option value="">All results</option>
          <option value="COMPLETED">Played</option>
          <option value="SKIPPED">Skipped</option>
          <option value="STOPPED">Stopped</option>
          <option value="FAILED">Failed</option>
        </select>
        <div className="date-pair">
          <label className="date-field">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => update("from", event.target.value)} />
          </label>
          <label className="date-field">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => update("to", event.target.value)} />
          </label>
        </div>
        <label className="check toolbar-check">
          <input type="checkbox" checked={filters.offline} onChange={(event) => update("offline", event.target.checked)} />
          Played offline only
        </label>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <Empty title="No reports" lede="Reports appear once speakers start playing announcements, broadcasts, or live tests." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Speaker</th>
                  <th>Audio</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th>Length</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((report) => (
                  <tr key={report.id}>
                    <td>
                      {formatWhen(report.startedAt)}
                      {report.scheduledFor ? <div className="muted">Due {formatWhen(report.scheduledFor)}</div> : null}
                    </td>
                    <td>
                      <strong>{report.speaker?.name}</strong>
                      <div className="muted">{report.speaker?.location}{global && report.speaker?.area ? ` · ${report.speaker.area.name}` : ""}</div>
                    </td>
                    <td>
                      {report.title}
                      {report.error ? <div className="muted">{report.error}</div> : null}
                    </td>
                    <td><Badge value={report.source}>{STATUS_LABEL[report.source]}</Badge></td>
                    <td>
                      <Badge value={report.result}>{STATUS_LABEL[report.result]}</Badge>
                      {report.playedOffline ? <div className="muted">Offline</div> : null}
                    </td>
                    <td>{formatDuration(report.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination meta={meta} onPageChange={setPage} />
    </section>
  );
}
