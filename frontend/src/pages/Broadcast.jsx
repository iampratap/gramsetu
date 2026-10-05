import { useEffect, useMemo, useRef, useState } from "react";
import { api, audioUrl, getToken } from "../api.js";
import { Badge, Banner, Empty, Field, PageHead, Pagination } from "../components/ui.jsx";
import { formatClock, formatDuration, formatWhen } from "../format.js";
import { useLiveSpeakers, useTicker } from "../live.js";
import { audioCaptureSupported, microphoneSupported, openBroadcastInput } from "../microphone.js";

const MODES = [
  ["microphone", "Microphone"],
  ["audio", "Audio only"],
];
const LOCAL_FILE = "__local__";

const SPEAKER_STATUS = {
  pending: "Waiting",
  joining: "Connecting",
  playing: "On air",
  offline: "Offline · joins when back",
  dropped: "Dropped · rejoins when back",
  busy: "Busy",
  failed: "Failed",
  stopped: "Left",
  completed: "Done",
  cancelled: "Not reached",
};
const RETRYABLE = new Set(["failed", "stopped", "busy"]);
const CLIP_VOLUME_STEP = 10;
const CLIP_VOLUME_MAX = 150;
const MAX_SEND_BACKLOG = 64 * 1024;

export function Broadcast() {
  const { speakers, connected: liveConnected } = useLiveSpeakers();
  const [selected, setSelected] = useState(() => new Set());
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState("idle");
  const [statuses, setStatuses] = useState([]);
  const [startedAt, setStartedAt] = useState(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const [mode, setMode] = useState("microphone");
  const [library, setLibrary] = useState([]);
  const [clipChoice, setClipChoice] = useState("");
  const [localFile, setLocalFile] = useState(null);
  const [clip, setClip] = useState(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [endWithAudio, setEndWithAudio] = useState(true);
  const [clipPaused, setClipPaused] = useState(false);
  const [clipVolume, setClipVolume] = useState(100);
  const [scrub, setScrub] = useState(null);
  const [speakerVolume, setSpeakerVolume] = useState({ busy: false, message: "" });
  const socketRef = useRef(null);
  const micRef = useRef(null);
  const endWithAudioRef = useRef(endWithAudio);
  endWithAudioRef.current = endWithAudio;
  const now = useTicker(500);
  const supported = mode === "audio" ? audioCaptureSupported() : microphoneSupported();
  const clipReady = clipChoice === LOCAL_FILE ? Boolean(localFile) : Boolean(clipChoice);

  useEffect(() => {
    api("/api/audio?page=1&pageSize=100")
      .then((data) => setLibrary(data.audioFiles))
      .catch(() => {});
  }, []);

  const byArea = useMemo(() => {
    const groups = new Map();
    for (const speaker of speakers) {
      const key = speaker.area?.name || "No area";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(speaker);
    }
    return [...groups.entries()];
  }, [speakers]);

  function cleanup() {
    micRef.current?.close();
    micRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000);
    setLevel(0);
    setMuted(false);
    setClip(null);
    setClipBusy(false);
    setClipPaused(false);
    setScrub(null);
  }

  function clipLabel() {
    if (clipChoice === LOCAL_FILE) return localFile?.name || "Audio file";
    return library.find((item) => item.id === clipChoice)?.title || "Audio";
  }

  async function playChosenClip() {
    const input = micRef.current;
    if (!input || !clipReady) return;
    setClipBusy(true);
    setError("");
    try {
      let data;
      if (clipChoice === LOCAL_FILE) {
        data = await localFile.arrayBuffer();
      } else {
        const response = await fetch(audioUrl(clipChoice));
        if (!response.ok) throw new Error(response.status === 404 ? "the file is missing from storage" : `download failed (${response.status})`);
        data = await response.arrayBuffer();
      }
      if (micRef.current !== input) return;
      const label = clipLabel();
      const { duration } = await input.playClip(data, {
        onEnded: () => {
          setClip(null);
          setClipPaused(false);
          setScrub(null);
          if (!input.hasMicrophone && endWithAudioRef.current) stop();
        },
      });
      setClip({ label, duration });
      setClipPaused(false);
      setScrub(null);
    } catch (err) {
      setError(`Could not play the audio: ${err?.message || err}`);
    } finally {
      setClipBusy(false);
    }
  }

  function stopClip() {
    micRef.current?.stopClip();
    setClip(null);
    setClipPaused(false);
    setScrub(null);
  }

  function togglePause() {
    const input = micRef.current;
    if (!input || !clip) return;
    if (clipPaused) input.resumeClip();
    else input.pauseClip();
    setClipPaused(!clipPaused);
  }

  function commitSeek() {
    if (scrub === null) return;
    micRef.current?.seekClip(scrub);
    setScrub(null);
  }

  function skipBy(seconds) {
    const input = micRef.current;
    if (!input || !clip) return;
    input.seekClip(input.clipPosition() + seconds);
    setScrub(null);
  }

  function changeClipVolume(delta) {
    const next = Math.min(CLIP_VOLUME_MAX, Math.max(0, clipVolume + delta));
    setClipVolume(next);
    micRef.current?.setClipVolume(next / 100);
  }

  async function changeSpeakerVolume(action) {
    const targets = statuses.filter((item) => item.status === "playing");
    if (!targets.length) return;
    setSpeakerVolume({ busy: true, message: "" });
    const results = await Promise.allSettled(
      targets.map((item) => api(`/api/speakers/${item.id}/command`, { method: "POST", body: { action } })),
    );
    const levels = results.map((result) => result.value?.state?.volume).filter((value) => value !== undefined);
    const failed = results.filter((result) => result.status === "rejected").length;
    setSpeakerVolume({
      busy: false,
      message:
        `${action === "volume_up" ? "Raised" : "Lowered"} on ${targets.length - failed} of ${targets.length} speaker(s)` +
        (levels.length ? ` · now ${Math.min(...levels)}${Math.min(...levels) === Math.max(...levels) ? "" : `–${Math.max(...levels)}`}%` : "") +
        (failed ? ` · ${failed} did not answer` : ""),
    });
  }

  function toggleMonitor() {
    const next = !monitor;
    setMonitor(next);
    micRef.current?.setMonitor(next);
  }

  useEffect(() => cleanup, []);

  useEffect(() => {
    if (phase !== "live" && phase !== "starting") return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectGroup(list, on) {
    setSelected((current) => {
      const next = new Set(current);
      for (const speaker of list) {
        if (on) next.add(speaker.id);
        else next.delete(speaker.id);
      }
      return next;
    });
  }

  async function start() {
    setError("");
    setNotice("");
    setPhase("starting");
    let mic;
    try {
      mic = await openBroadcastInput({
        microphone: mode === "microphone",
        onFrame: (frame) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN && socket.live && socket.bufferedAmount < MAX_SEND_BACKLOG) socket.send(frame);
        },
        onLevel: setLevel,
      });
    } catch (err) {
      setPhase("idle");
      setError(
        err?.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow the microphone for this site in the browser's address bar and try again."
          : err?.name === "NotFoundError"
            ? "No microphone was found on this device."
            : `Could not open the microphone: ${err?.message || err}`,
      );
      return;
    }
    micRef.current = mic;
    mic.setMonitor(monitor);
    mic.setClipVolume(clipVolume / 100);
    const broadcastTitle = title.trim() || (mode === "audio" && clipReady ? clipLabel() : "");
    if (broadcastTitle !== title) setTitle(broadcastTitle);

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/broadcast?token=${encodeURIComponent(getToken() || "")}`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start", title: broadcastTitle, speakerIds: [...selected] }));
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "started") {
        socket.live = true;
        setStatuses(message.speakers);
        setStartedAt(Date.now());
        setPhase("live");
        if (clipReady) playChosenClip();
      } else if (message.type === "speaker") {
        setStatuses((current) => current.map((item) => (item.id === message.speaker.id ? message.speaker : item)));
      } else if (message.type === "error") {
        setError(message.message);
        setPhase("idle");
        cleanup();
      } else if (message.type === "ended") {
        const results = Object.values(message.results || {});
        const reached = results.filter((item) => item.status === "completed").length;
        setStatuses(results);
        setNotice(`Broadcast ended (${message.reason}). Reached ${reached} of ${results.length} speaker(s).`);
        setPhase("idle");
        setHistoryKey((key) => key + 1);
        cleanup();
      }
    };
    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;
      setPhase("idle");
      setError(event.code === 1006 ? "Lost the connection to GramSetu. The broadcast has ended." : "The broadcast connection closed.");
      setHistoryKey((key) => key + 1);
      cleanup();
    };
  }

  function stop() {
    setPhase("ending");
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    else cleanup();
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    micRef.current?.setMuted(next);
  }

  function retry(speakerId) {
    socketRef.current?.send(JSON.stringify({ type: "retry", speakerId }));
  }

  const live = phase === "live" || phase === "ending";
  const onAir = statuses.filter((item) => item.status === "playing").length;
  const selectedOnline = speakers.filter((speaker) => selected.has(speaker.id) && speaker.connected).length;
  const clipPosition = clip ? (scrub ?? micRef.current?.clipPosition() ?? 0) : 0;

  const clipPicker = (
    <div className="clip-picker">
      <select
        value={clipChoice}
        onChange={(event) => setClipChoice(event.target.value)}
        disabled={phase === "ending" || phase === "starting"}
        aria-label="Audio to play"
      >
        <option value="">{mode === "audio" && !live ? "Choose audio to play" : "No audio"}</option>
        {library.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
            {item.area?.name ? ` · ${item.area.name}` : ""}
          </option>
        ))}
        <option value={LOCAL_FILE}>File from this device…</option>
      </select>
      {clipChoice === LOCAL_FILE ? (
        <input type="file" accept="audio/*" onChange={(event) => setLocalFile(event.target.files?.[0] || null)} disabled={phase === "ending"} />
      ) : null}
    </div>
  );

  return (
    <section className="page page-wide">
      <PageHead
        eyebrow="Field"
        title="Live broadcast"
        lede="Talk into your microphone or play an audio file, and the chosen speakers play it live. Whatever they were playing pauses and continues afterwards."
      >
        {live ? (
          <span className="live-pill on">
            <span className="live-dot" />
            On air · {onAir}/{statuses.length}
          </span>
        ) : null}
      </PageHead>

      {!supported ? (
        <div className="banner">
          Browsers only allow live audio on secure pages.{" "}
          {window.location.protocol === "http:" ? (
            <>
              <a href={`https://${window.location.host}${window.location.pathname}`}>Open the secure (https) version</a> and sign in
              there to broadcast.
            </>
          ) : (
            "This browser does not support live audio capture."
          )}
        </div>
      ) : null}
      <Banner>{error}</Banner>
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="broadcast-layout">
        <div className="panel broadcast-console">
          {live ? (
            <>
              <div className="on-air">
                <span className="on-air-dot" />
                <div>
                  <strong>{title.trim() || "Live announcement"}</strong>
                  <div className="muted">
                    {micRef.current?.hasMicrophone ? (muted ? "Microphone muted" : "Speak now") : clip ? (clipPaused ? "Audio paused" : "Playing audio") : "Audio only · nothing playing"} ·{" "}
                    {formatClock(startedAt ? (now - startedAt) / 1000 : 0)}
                  </div>
                </div>
              </div>
              <div className="mic-meter" aria-label="Broadcast level">
                <span style={{ width: `${Math.round(Math.min(1, level * 1.6) * 100)}%` }} />
              </div>

              <div className="clip-console">
                <div className="clip-console-head">
                  <strong>Play audio</strong>
                  <label className="check">
                    <input type="checkbox" checked={monitor} onChange={toggleMonitor} />
                    Hear it here too
                  </label>
                </div>
                {clip ? (
                  <div className="clip-now">
                    <div>
                      <strong>{clip.label}</strong>
                      <span className="muted"> · {clipPaused ? "Paused" : "Playing"}</span>
                    </div>
                    <div className="clip-seek">
                      <span className="muted">{formatClock(clipPosition)}</span>
                      <input
                        type="range"
                        min="0"
                        max={clip.duration || 0}
                        step="0.1"
                        value={Math.min(clipPosition, clip.duration || 0)}
                        onChange={(event) => setScrub(Number(event.target.value))}
                        onPointerUp={commitSeek}
                        onKeyUp={commitSeek}
                        onBlur={commitSeek}
                        disabled={phase === "ending"}
                        aria-label="Seek"
                      />
                      <span className="muted">{formatClock(clip.duration)}</span>
                    </div>
                    <div className="clip-controls">
                      <button className="btn ghost small" type="button" onClick={() => skipBy(-10)} disabled={phase === "ending"} aria-label="Back 10 seconds">−10 s</button>
                      <button className="btn primary small" type="button" onClick={togglePause} disabled={phase === "ending"}>
                        {clipPaused ? "Resume" : "Pause"}
                      </button>
                      <button className="btn ghost small" type="button" onClick={() => skipBy(10)} disabled={phase === "ending"} aria-label="Forward 10 seconds">+10 s</button>
                      <button className="btn ghost small" type="button" onClick={stopClip} disabled={phase === "ending"}>Stop</button>
                      <span className="control-gap" />
                      <button className="btn ghost small" type="button" onClick={() => changeClipVolume(-CLIP_VOLUME_STEP)} disabled={clipVolume <= 0} aria-label="Audio volume down">Vol −</button>
                      <span className="clip-volume" title="Level of the audio in the broadcast">{clipVolume}%</span>
                      <button className="btn ghost small" type="button" onClick={() => changeClipVolume(CLIP_VOLUME_STEP)} disabled={clipVolume >= CLIP_VOLUME_MAX} aria-label="Audio volume up">Vol +</button>
                    </div>
                  </div>
                ) : null}
                {clipPicker}
                <div className="broadcast-actions">
                  <button className="btn" type="button" onClick={playChosenClip} disabled={!clipReady || clipBusy || phase === "ending"}>
                    {clipBusy ? "Loading…" : clip ? "Change audio" : "Play audio"}
                  </button>
                </div>
                {!micRef.current?.hasMicrophone ? (
                  <label className="check">
                    <input type="checkbox" checked={endWithAudio} onChange={(event) => setEndWithAudio(event.target.checked)} />
                    End the broadcast when the audio finishes
                  </label>
                ) : null}
              </div>

              <div className="speaker-volume">
                <span>Speaker volume</span>
                <button className="btn ghost small" type="button" onClick={() => changeSpeakerVolume("volume_down")} disabled={!onAir || speakerVolume.busy || phase === "ending"}>Vol −</button>
                <button className="btn ghost small" type="button" onClick={() => changeSpeakerVolume("volume_up")} disabled={!onAir || speakerVolume.busy || phase === "ending"}>Vol +</button>
                <small className="muted">{speakerVolume.busy ? "Sending…" : speakerVolume.message || "Changes the volume on every speaker on air and stays after the broadcast."}</small>
              </div>

              <div className="broadcast-actions">
                {micRef.current?.hasMicrophone ? (
                  <button className="btn ghost" type="button" onClick={toggleMute} disabled={phase === "ending"}>
                    {muted ? "Unmute mic" : "Mute mic"}
                  </button>
                ) : null}
                <button className="btn danger" type="button" onClick={stop} disabled={phase === "ending"}>
                  {phase === "ending" ? "Ending…" : "End broadcast"}
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="Source">
                <div className="segmented">
                  {MODES.map(([value, label]) => (
                    <button key={value} type="button" className={mode === value ? "on" : ""} onClick={() => setMode(value)}>
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Title" hint="Shown on the Speakers page and in play reports.">
                <input
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={mode === "audio" && clipReady ? clipLabel() : "Live announcement"}
                />
              </Field>
              <Field
                label={mode === "audio" ? "Audio to play" : "Audio to play first (optional)"}
                hint={
                  mode === "audio"
                    ? "Plays as soon as the broadcast starts. You can switch to other audio while on air."
                    : "Plays mixed with your microphone. You can also start audio later while on air."
                }
              >
                {clipPicker}
              </Field>
              {mode === "audio" ? (
                <label className="check">
                  <input type="checkbox" checked={endWithAudio} onChange={(event) => setEndWithAudio(event.target.checked)} />
                  End the broadcast when the audio finishes
                </label>
              ) : null}
              <p className="muted">
                {selected.size} speaker(s) selected, {selectedOnline} online now. Offline speakers join if they reconnect during the broadcast.
              </p>
              <button
                className="btn primary broadcast-start"
                type="button"
                disabled={!supported || selected.size === 0 || phase === "starting" || (mode === "audio" && !clipReady)}
                onClick={start}
              >
                {phase === "starting" ? "Starting…" : "Start broadcast"}
              </button>
            </>
          )}

          {statuses.length ? (
            <ul className="broadcast-status">
              {statuses.map((item) => (
                <li key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <span className="muted"> · {item.area}</span>
                    {item.error ? <div className="muted">{item.error}</div> : null}
                  </span>
                  <span className="broadcast-status-right">
                    <Badge value={`b-${item.status}`}>{SPEAKER_STATUS[item.status] || item.status}</Badge>
                    {phase === "live" && RETRYABLE.has(item.status) ? (
                      <button className="btn ghost small" type="button" onClick={() => retry(item.id)}>Retry</button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="panel broadcast-picker">
          <div className="panel-head">
            <h2>Speakers</h2>
            <span className="muted">{liveConnected ? "Live status" : "Connecting…"}</span>
          </div>
          {speakers.length === 0 ? (
            <Empty title="No speakers" lede="Speakers appear here once they are added on the Speakers page." />
          ) : (
            byArea.map(([area, list]) => {
              const online = list.filter((speaker) => speaker.connected);
              return (
                <fieldset key={area} className="picker-group" disabled={live || phase === "starting"}>
                  <legend>
                    {area}
                    <button type="button" className="link-button" onClick={() => selectGroup(online, true)}>Select online</button>
                    <button type="button" className="link-button" onClick={() => selectGroup(list, false)}>Clear</button>
                  </legend>
                  {list.map((speaker) => (
                    <label key={speaker.id} className={`picker-row${speaker.connected ? "" : " is-offline"}`}>
                      <input type="checkbox" checked={selected.has(speaker.id)} onChange={() => toggle(speaker.id)} />
                      <span>
                        <strong>{speaker.name}</strong>
                        <span className="muted"> · {speaker.location}</span>
                      </span>
                      <Badge value={speaker.connected ? "ONLINE" : speaker.status}>
                        {speaker.connected ? (speaker.state?.status === "broadcast" ? "On air" : "Online") : speaker.status === "MAINTENANCE" ? "Maintenance" : "Offline"}
                      </Badge>
                    </label>
                  ))}
                </fieldset>
              );
            })
          )}
        </div>
      </div>

      <BroadcastHistory refreshKey={historyKey} />
    </section>
  );
}

function BroadcastHistory({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api(`/api/broadcasts?page=${page}&pageSize=10`)
      .then((data) => {
        setRows(data.broadcasts);
        setMeta(data.meta);
      })
      .catch(() => {});
  }, [page, refreshKey]);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Recent broadcasts</h2>
        </div>
        {rows.length === 0 ? (
          <Empty title="No broadcasts yet" lede="Finished broadcasts are listed here with how many speakers they reached." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Title</th>
                  <th>By</th>
                  <th>Reached</th>
                  <th>Length</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const results = Object.values(row.results || {});
                  const reached = results.filter((item) => item.status === "completed").length;
                  return (
                    <tr key={row.id}>
                      <td>{formatWhen(row.startedAt)}</td>
                      <td>{row.title}</td>
                      <td>{row.createdBy?.name}</td>
                      <td>
                        {row.endedAt ? `${reached} of ${row.speakerIds.length}` : <Badge value="b-playing">On air</Badge>}
                        {results.length > reached ? (
                          <div className="muted">
                            {results.filter((item) => item.status !== "completed").map((item) => `${item.name}: ${SPEAKER_STATUS[item.status] || item.status}`).join(", ")}
                          </div>
                        ) : null}
                      </td>
                      <td>{row.durationMs ? formatDuration(row.durationMs) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination meta={meta} onPageChange={setPage} />
    </>
  );
}
