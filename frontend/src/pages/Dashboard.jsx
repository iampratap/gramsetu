import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Badge, Banner, PageHead } from "../components/ui.jsx";
import { STATUS_LABEL, formatWhen } from "../format.js";

const BLURB = {
  SUPERADMIN: "You can add platform admins and see every village on the network.",
  ADMIN: "You set up areas, speakers, and the maker and checker for each village.",
  MAKER: "Upload audio to the collection or draft an announcement. Files are stored as 16 kHz mono WAV in S3. Nothing plays until a checker approves it.",
  CHECKER: "Listen to pending announcements for your area, then approve or reject them.",
};

export function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/dashboard")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  const canOpenAreas = user.role === "SUPERADMIN" || user.role === "ADMIN";
  const cards = data
    ? [
        ["Areas", data.areas, canOpenAreas ? "/areas" : ""],
        ["Speakers online", `${data.speakersOnline}/${data.speakers}`, "/speakers"],
        ["Audio files", data.audioFiles, "/audio"],
        ["Pending review", data.announcements.PENDING, "/announcements"],
      ]
    : [];

  return (
    <section className="page">
      <PageHead eyebrow="Overview" title={`Hello, ${user.name.split(" ")[0]}`} lede={BLURB[user.role]} />
      <Banner>{error}</Banner>
      <div className="stat-grid">
        {cards.map(([label, value, to]) => {
          const body = (
            <>
              <span>{label}</span>
              <strong>{value}</strong>
            </>
          );
          return to ? (
            <Link key={label} to={to} className="stat">
              {body}
            </Link>
          ) : (
            <div key={label} className="stat">
              {body}
            </div>
          );
        })}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Recent announcements</h2>
          <Link to="/announcements">Open queue</Link>
        </div>
        {!data ? <p className="muted">Loading…</p> : null}
        {data && data.recent.length === 0 ? <p className="muted">No announcements yet.</p> : null}
        {data && data.recent.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Area</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <div className="muted">{item.audioFile?.title}</div>
                    </td>
                    <td>{item.area?.name}</td>
                    <td><Badge value={item.status}>{STATUS_LABEL[item.status]}</Badge></td>
                    <td>{formatWhen(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
