import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Banner, PageHead } from "../components/ui.jsx";
import { STATUS_LABEL, formatWhen } from "../format.js";
import { useLiveSpeakers, useTicker } from "../live.js";
import { INDIA_CENTER, L, addBaseLayers, escapeHtml, pinIcon } from "../map.js";

const SOON_MS = 60 * 60 * 1000;

const STATES = {
  broadcast: { label: "Live broadcast", hint: "Playing a live broadcast right now" },
  playing: { label: "Playing", hint: "Playing an announcement right now" },
  online: { label: "Online, idle", hint: "Connected and waiting" },
  offline: { label: "Offline", hint: "Not connected; still plays stored announcements on time" },
  maintenance: { label: "Maintenance", hint: "Taken out of service for repairs" },
  retired: { label: "Retired", hint: "No longer in service" },
};

function currentState(speaker) {
  if (!speaker.isActive || speaker.status === "RETIRED") return "retired";
  if (speaker.status === "MAINTENANCE") return "maintenance";
  if (!speaker.connected) return "offline";
  if (speaker.state?.status === "broadcast") return "broadcast";
  if (speaker.state?.status === "playing") return "playing";
  return "online";
}

function relative(at, now) {
  const minutes = Math.round((new Date(at).getTime() - now) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.round(hours / 24)} day(s)`;
}

function nextFor(speaker, upcoming) {
  const fromServer = upcoming[speaker.id]?.next;
  if (fromServer) return fromServer;
  const fromDevice = speaker.state?.nextSchedule;
  return fromDevice?.at ? { title: fromDevice.title, at: fromDevice.at } : null;
}

function popupHtml(speaker, info, next, now) {
  const state = currentState(speaker);
  const playing = speaker.connected ? speaker.state?.nowPlaying : null;
  const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const rows = [
    row(
      "Now",
      playing
        ? `${escapeHtml(playing.title)} <span class="muted">· ${escapeHtml(STATUS_LABEL[playing.source] || playing.source || "")}</span>`
        : speaker.connected
          ? "Nothing playing"
          : `<span class="muted">Last seen ${escapeHtml(formatWhen(speaker.lastSeenAt))}</span>`,
    ),
    row(
      "Next",
      next
        ? `${escapeHtml(next.title)}<br><span class="muted">${escapeHtml(formatWhen(next.at))} · ${relative(next.at, now)}</span>`
        : '<span class="muted">Nothing scheduled in the next 8 days</span>',
    ),
  ];
  if (info?.next24h) rows.push(row("Next 24 h", `${info.next24h} timed announcement(s)`));
  if (info?.waiting) {
    rows.push(row("Waiting", `${info.waiting} approved announcement(s) ${speaker.connected ? "being delivered" : "play when it reconnects"}`));
  }
  if (speaker.connected && speaker.state?.volume !== undefined) rows.push(row("Volume", `${speaker.state.volume}%`));
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${speaker.latitude},${speaker.longitude}`;
  return `
    <div class="map-popup">
      <strong>${escapeHtml(speaker.name)}</strong>
      <div class="muted">${escapeHtml(speaker.location)}${speaker.area?.name ? ` · ${escapeHtml(speaker.area.name)}` : ""}</div>
      <div class="map-popup-state"><span class="map-dot map-pin-${state}"></span>${STATES[state].label}</div>
      <dl>${rows.join("")}</dl>
      <div class="map-popup-links">
        <a data-app-link href="/speakers?q=${encodeURIComponent(speaker.deviceId)}">Open in Speakers</a>
        <a href="${directions}" target="_blank" rel="noopener">Directions</a>
      </div>
    </div>`;
}

export function SpeakerMap() {
  const { user } = useAuth();
  const global = user.role === "SUPERADMIN" || user.role === "ADMIN";
  const { speakers, connected } = useLiveSpeakers();
  const [upcoming, setUpcoming] = useState({});
  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState("");
  const [shown, setShown] = useState(() => new Set(Object.keys(STATES)));
  const [soonOnly, setSoonOnly] = useState(false);
  const [error, setError] = useState("");
  const now = useTicker(15000);
  const holder = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const fittedRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    let stopped = false;
    const load = () =>
      api("/api/speakers/upcoming")
        .then((data) => {
          if (!stopped) setUpcoming(data.upcoming);
        })
        .catch((err) => !stopped && setError(err.message));
    load();
    const timer = setInterval(load, 60000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (global) api("/api/areas").then((data) => setAreas(data.areas)).catch(() => {});
  }, [global]);

  useEffect(() => {
    const map = L.map(holder.current).setView(INDIA_CENTER, 5);
    addBaseLayers(map);
    mapRef.current = map;
    const markers = markersRef.current;
    const element = holder.current;
    const openInApp = (event) => {
      const link = event.target.closest("a[data-app-link]");
      if (!link) return;
      event.preventDefault();
      navigate(link.getAttribute("href"));
    };
    element.addEventListener("click", openInApp);
    return () => {
      element.removeEventListener("click", openInApp);
      map.remove();
      markers.clear();
      mapRef.current = null;
    };
  }, []);

  const placed = useMemo(() => speakers.filter((speaker) => speaker.latitude !== null && speaker.longitude !== null), [speakers]);
  const unplaced = useMemo(() => speakers.filter((speaker) => speaker.latitude === null || speaker.longitude === null), [speakers]);

  const visible = useMemo(
    () =>
      placed.filter((speaker) => {
        if (areaId && speaker.areaId !== areaId) return false;
        if (!shown.has(currentState(speaker))) return false;
        if (soonOnly) {
          const next = nextFor(speaker, upcoming);
          if (!next || new Date(next.at).getTime() - now > SOON_MS) return false;
        }
        return true;
      }),
    [placed, areaId, shown, soonOnly, upcoming, now],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const keep = new Set();
    for (const speaker of visible) {
      keep.add(speaker.id);
      const info = upcoming[speaker.id];
      const next = nextFor(speaker, upcoming);
      const soon = next && new Date(next.at).getTime() - now <= SOON_MS;
      const state = currentState(speaker);
      const icon = pinIcon(`map-pin-${state}${soon ? " is-soon" : ""}`, info?.waiting ? `<b>${info.waiting}</b>` : "");
      const html = popupHtml(speaker, info, next, now);
      let marker = markers.get(speaker.id);
      if (!marker) {
        marker = L.marker([speaker.latitude, speaker.longitude], { icon, title: speaker.name, riseOnHover: true }).bindPopup(html, { maxWidth: 300 });
        marker.addTo(map);
        markers.set(speaker.id, marker);
      } else {
        marker.setLatLng([speaker.latitude, speaker.longitude]);
        marker.setIcon(icon);
        marker.setPopupContent(html);
      }
      marker.setZIndexOffset(state === "broadcast" || state === "playing" ? 1000 : soon ? 500 : 0);
    }
    for (const [id, marker] of markers) {
      if (!keep.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
    if (!fittedRef.current && visible.length) {
      fittedRef.current = true;
      fitAll();
    }
  }, [visible, upcoming, now]);

  function fitAll() {
    const map = mapRef.current;
    if (!map || !visible.length) return;
    map.fitBounds(L.latLngBounds(visible.map((speaker) => [speaker.latitude, speaker.longitude])), { padding: [40, 40], maxZoom: 15 });
  }

  function toggleState(key) {
    setShown((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const counts = useMemo(() => {
    const result = {};
    for (const speaker of placed) {
      const key = currentState(speaker);
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }, [placed]);
  const soonCount = placed.filter((speaker) => {
    const next = nextFor(speaker, upcoming);
    return next && new Date(next.at).getTime() - now <= SOON_MS;
  }).length;

  return (
    <section className="page page-wide">
      <PageHead
        eyebrow="Field"
        title="Map"
        lede="Where every speaker is, what it is doing now, and what it plays next. Click a pin for details."
      >
        <span className={`live-pill${connected ? " on" : ""}`}>
          <span className="live-dot" />
          {connected ? `Live · ${placed.length} on map` : "Reconnecting…"}
        </span>
        <button className="btn ghost" type="button" onClick={fitAll} disabled={!visible.length}>
          Show all
        </button>
      </PageHead>
      <Banner>{error}</Banner>

      <div className="toolbar map-toolbar">
        {global ? (
          <select
            value={areaId}
            onChange={(event) => {
              setAreaId(event.target.value);
              fittedRef.current = false;
            }}
          >
            <option value="">All areas</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>{area.name}</option>
            ))}
          </select>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={soonOnly} onChange={(event) => setSoonOnly(event.target.checked)} />
          Only speakers playing within the hour ({soonCount})
        </label>
      </div>

      <div className="map-layout">
        <div className="panel map-panel">
          <div ref={holder} className="speaker-map" />
        </div>
        <aside className="panel map-side">
          <h2>Legend</h2>
          <p className="muted">Pin colour is what the speaker is doing now. Click to hide or show a group.</p>
          <ul className="map-legend">
            {Object.entries(STATES).map(([key, item]) => (
              <li key={key}>
                <button type="button" className={shown.has(key) ? "" : "is-off"} onClick={() => toggleState(key)} title={item.hint}>
                  <span className={`map-dot map-pin-${key}`} />
                  <span>{item.label}</span>
                  <span className="muted">{counts[key] || 0}</span>
                </button>
              </li>
            ))}
          </ul>
          <ul className="map-legend map-legend-static">
            <li>
              <span className="map-dot map-pin-online is-soon" />
              <span>Amber ring: plays a timed announcement within the hour</span>
            </li>
            <li>
              <span className="map-dot map-pin-offline map-dot-count">2</span>
              <span>Number: approved announcements waiting to reach the speaker</span>
            </li>
          </ul>
          {unplaced.length ? (
            <>
              <h2>Not on the map ({unplaced.length})</h2>
              <p className="muted">{global ? "Set their position in Speakers → Edit & setup." : "An admin can set their position."}</p>
              <ul className="map-unplaced">
                {unplaced.map((speaker) => (
                  <li key={speaker.id}>
                    {global ? (
                      <Link to={`/speakers?q=${encodeURIComponent(speaker.deviceId)}`}>{speaker.name}</Link>
                    ) : (
                      speaker.name
                    )}
                    <span className="muted"> · {speaker.area?.name}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
