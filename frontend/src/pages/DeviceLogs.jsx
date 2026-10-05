import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, getToken } from "../api.js";
import { Banner, Empty, PageHead, Pagination } from "../components/ui.jsx";
import { useDebounced } from "../format.js";
import { useLiveSpeakers } from "../live.js";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const RANK = Object.fromEntries(LEVELS.map((level, index) => [level, index]));
const LIVE_LIMIT = 3000;
const TABS = [
  ["live", "Live"],
  ["history", "History"],
  ["device", "From the Pi"],
];

function logTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString("en-CA")} ${date.toLocaleTimeString("en-GB", { hour12: false })}`;
}

function LogLine({ entry, showSpeaker }) {
  return (
    <div className={`log-line lvl-${entry.level.toLowerCase()}`}>
      <time>{logTime(entry.loggedAt)}</time>
      <span className="log-level">{entry.level}</span>
      {showSpeaker ? <span className="log-speaker">{entry.speakerName || entry.speaker?.name}</span> : null}
      <span className="log-logger">{entry.logger}</span>
      <span className="log-msg">{entry.message}</span>
    </div>
  );
}

export function DeviceLogs() {
  const [params, setParams] = useSearchParams();
  const speakerId = params.get("speaker") || "";
  const tab = TABS.some(([key]) => key === params.get("tab")) ? params.get("tab") : "live";
  const { speakers } = useLiveSpeakers();
  const selected = speakers.find((speaker) => speaker.id === speakerId) || null;

  function setParam(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <section className="page page-wide">
      <PageHead
        eyebrow="Diagnostics"
        title="Device logs"
        lede="Logs from the Raspberry Pi speaker agents. Lines written while a speaker was offline are kept on the Pi and arrive when it reconnects."
      />
      <div className="toolbar">
        <select value={speakerId} onChange={(event) => setParam("speaker", event.target.value)}>
          <option value="">All speakers</option>
          {speakers.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.name} ({speaker.area?.name}){speaker.connected ? "" : " · offline"}
            </option>
          ))}
        </select>
        <div className="tabs" role="tablist">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`tab${tab === key ? " active" : ""}`}
              onClick={() => setParam("tab", key === "live" ? "" : key)}
            >
              {label}
            </button>
          ))}
        </div>
        {selected ? <LevelControl speaker={selected} /> : null}
      </div>
      {tab === "live" ? <LiveLogs key={speakerId} speakerId={speakerId} showSpeaker={!speakerId} /> : null}
      {tab === "history" ? <HistoryLogs speakerId={speakerId} showSpeaker={!speakerId} /> : null}
      {tab === "device" ? <DeviceJournal speaker={selected} /> : null}
    </section>
  );
}

function LevelControl({ speaker }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const level = speaker.state?.logLevel;
  const debug = level === "DEBUG";

  async function toggle() {
    setBusy(true);
    setMessage("");
    try {
      const result = await api(`/api/device-logs/${speaker.id}/level`, { method: "POST", body: { level: debug ? "INFO" : "DEBUG" } });
      setMessage(result.message);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="level-control">
      <span className="muted">Level: {level || "—"}</span>
      <button className="btn ghost small" type="button" disabled={!speaker.connected || busy} onClick={toggle}>
        {debug ? "Turn debug off" : "Turn debug on"}
      </button>
      {message ? <span className="muted">{message}</span> : null}
    </div>
  );
}

function LiveLogs({ speakerId, showSpeaker }) {
  const [lines, setLines] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [minLevel, setMinLevel] = useState("DEBUG");
  const [filter, setFilter] = useState("");
  const pausedRef = useRef(false);
  const held = useRef([]);
  const consoleRef = useRef(null);

  useEffect(() => {
    let socket;
    let timer;
    let closed = false;
    let retry = 1000;
    const append = (entries) => setLines((current) => [...current, ...entries].slice(-LIVE_LIMIT));

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const query = new URLSearchParams({ token: getToken() || "" });
      if (speakerId) query.set("speakerId", speakerId);
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/logs?${query.toString()}`);
      socket.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "backlog") {
          held.current = [];
          setLines(message.entries);
        } else if (message.type === "logs") {
          if (pausedRef.current) held.current.push(...message.entries);
          else append(message.entries);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [speakerId]);

  const visible = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return lines.filter(
      (entry) =>
        RANK[entry.level] >= RANK[minLevel] &&
        (!text || entry.message.toLowerCase().includes(text) || entry.logger.toLowerCase().includes(text)),
    );
  }, [lines, minLevel, filter]);

  useEffect(() => {
    if (follow && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [visible, follow]);

  function togglePause() {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && held.current.length) {
      const entries = held.current;
      held.current = [];
      setLines((current) => [...current, ...entries].slice(-LIVE_LIMIT));
    }
  }

  return (
    <div className="panel log-panel">
      <div className="log-toolbar">
        <span className={`live-pill${connected ? " on" : ""}`}>
          <span className="live-dot" />
          {connected ? (paused ? "Paused" : "Streaming") : "Reconnecting…"}
        </span>
        <select value={minLevel} onChange={(event) => setMinLevel(event.target.value)} aria-label="Minimum level">
          {LEVELS.map((level) => (
            <option key={level} value={level}>{level === "DEBUG" ? "All levels" : `${level} and above`}</option>
          ))}
        </select>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter text" />
        <button className="btn ghost small" type="button" onClick={togglePause}>{paused ? `Resume (${held.current.length})` : "Pause"}</button>
        <button className="btn ghost small" type="button" onClick={() => setLines([])}>Clear</button>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
      </div>
      <div className="console" ref={consoleRef}>
        {visible.length === 0 ? (
          <p className="console-empty">{connected ? "Waiting for log lines…" : "Connecting…"}</p>
        ) : (
          visible.map((entry) => <LogLine key={`${entry.speakerId}-${entry.localId}`} entry={entry} showSpeaker={showSpeaker} />)
        )}
      </div>
    </div>
  );
}

function toIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function HistoryLogs({ speakerId, showSpeaker }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const q = useDebounced(search, 350);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (speakerId) params.set("speakerId", speakerId);
    if (level) params.set("level", level);
    if (q.trim()) params.set("q", q.trim());
    if (toIso(from)) params.set("from", toIso(from));
    if (toIso(to)) params.set("to", toIso(to));
    return params;
  }, [speakerId, level, q, from, to]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  useEffect(() => {
    const params = new URLSearchParams(query);
    params.set("page", String(page));
    params.set("pageSize", "100");
    setLoading(true);
    api(`/api/device-logs?${params.toString()}`)
      .then((data) => {
        setRows(data.logs);
        setMeta(data.meta);
        setError("");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query, page]);

  const exportParams = new URLSearchParams(query);
  exportParams.set("access_token", getToken() || "");

  return (
    <>
      <Banner>{error}</Banner>
      <div className="panel log-panel">
        <div className="log-toolbar">
          <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Minimum level">
            <option value="">All levels</option>
            {LEVELS.slice(1).map((name) => (
              <option key={name} value={name}>{name} and above</option>
            ))}
          </select>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" />
          <label className="date-field">
            <span>From</span>
            <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="date-field">
            <span>To</span>
            <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          {from || to ? (
            <button className="btn ghost small" type="button" onClick={() => { setFrom(""); setTo(""); }}>Clear dates</button>
          ) : null}
          <a className="btn ghost small" href={`/api/device-logs/export?${exportParams.toString()}`}>Download .log</a>
          <span className="muted">{meta ? `${meta.total.toLocaleString()} lines · newest first` : loading ? "Loading…" : ""}</span>
        </div>
        {rows.length === 0 && !loading ? (
          <Empty title="No log lines" lede="Try a wider date range or a lower level. Logs are kept on the server for 30 days." />
        ) : (
          <div className="console console-history">
            {rows.map((entry) => <LogLine key={entry.id} entry={entry} showSpeaker={showSpeaker} />)}
          </div>
        )}
      </div>
      <Pagination meta={meta} onPageChange={setPage} />
    </>
  );
}

const SOURCES = [
  ["agent", "GramSetu agent (journal)"],
  ["system", "Whole system journal"],
  ["boot", "Since last boot"],
  ["kernel", "Kernel"],
  ["diagnostics", "Health check (disk, memory, temperature, audio, network)"],
];

function DeviceJournal({ speaker }) {
  const [source, setSource] = useState("agent");
  const [lines, setLines] = useState("500");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const outputRef = useRef(null);

  useEffect(() => {
    setResult(null);
    setError("");
  }, [speaker?.id]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = source === "diagnostics" ? 0 : outputRef.current.scrollHeight;
  }, [result, source]);

  if (!speaker) {
    return (
      <div className="panel">
        <Empty title="Choose a speaker" lede="Pick one speaker above to read its system journal or run a health check on the Pi." />
      </div>
    );
  }

  async function fetchLogs() {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ source, lines });
      setResult(await api(`/api/device-logs/${speaker.id}/journal?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([result.text], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${speaker.deviceId}-${result.source}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <>
      <Banner>{error}</Banner>
      <div className="panel log-panel">
        <div className="log-toolbar">
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Log source">
            {SOURCES.map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {source !== "diagnostics" ? (
            <select value={lines} onChange={(event) => setLines(event.target.value)} aria-label="Lines">
              {["200", "500", "1000", "2000", "5000"].map((count) => (
                <option key={count} value={count}>Last {count} lines</option>
              ))}
            </select>
          ) : null}
          <button className="btn primary small" type="button" disabled={!speaker.connected || busy} onClick={fetchLogs}>
            {busy ? "Fetching…" : "Fetch from Pi"}
          </button>
          {result ? <button className="btn ghost small" type="button" onClick={download}>Download</button> : null}
          {!speaker.connected ? <span className="muted">Speaker is offline. Use the History tab for stored logs.</span> : null}
          {result?.truncated ? <span className="muted">Output trimmed to the most recent 600 KB.</span> : null}
        </div>
        <pre className="console console-raw" ref={outputRef}>
          {result ? result.text || "(no output)" : "Read the Pi's own system logs, including boot, kernel and audio driver messages the agent cannot see."}
        </pre>
      </div>
    </>
  );
}
