import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "../api.js";
import { Empty, Field, PageHead } from "../components/ui.jsx";
import { useLiveSpeakers } from "../live.js";

const USER_KEY = "gramsetu_ssh_user";

export function RemoteShell() {
  const [params, setParams] = useSearchParams();
  const speakerId = params.get("speaker") || "";
  const { speakers } = useLiveSpeakers();
  const speaker = speakers.find((item) => item.id === speakerId) || null;

  const [username, setUsername] = useState(() => localStorage.getItem(USER_KEY) || "pi");
  const [method, setMethod] = useState("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState("");

  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      theme: { background: "#0b1f3a", foreground: "#e6eef9", cursor: "#7cc0ff", selectionBackground: "#2d5c94" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.writeln("\x1b[38;5;153mChoose a speaker and log in to open a shell on the Raspberry Pi.\x1b[0m");
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "data", data }));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      socketRef.current?.close();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    socketRef.current?.close();
  }, [speakerId]);

  function selectSpeaker(id) {
    const next = new URLSearchParams(params);
    if (id) next.set("speaker", id);
    else next.delete("speaker");
    setParams(next, { replace: true });
  }

  function connect(event) {
    event.preventDefault();
    if (!speaker || phase === "connecting" || phase === "connected") return;
    const term = termRef.current;
    localStorage.setItem(USER_KEY, username.trim());
    term.reset();
    fitRef.current.fit();
    setPhase("connecting");
    setStatus("Connecting…");

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams({ token: getToken() || "", speakerId: speaker.id });
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal?${query.toString()}`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const credentials = {
      type: "connect",
      username: username.trim(),
      cols: term.cols,
      rows: term.rows,
      ...(method === "password" ? { password } : { privateKey, passphrase }),
    };

    socket.onopen = () => {
      socket.send(JSON.stringify(credentials));
      setPassword("");
      setPassphrase("");
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") {
        term.write(new Uint8Array(message.data));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === "status") {
        setStatus(payload.message);
        if (payload.connected) {
          setPhase("connected");
          term.focus();
        } else {
          term.writeln(`\x1b[38;5;153m${payload.message}\x1b[0m`);
        }
      }
    };
    socket.onclose = (closeEvent) => {
      if (socketRef.current === socket) socketRef.current = null;
      setPhase("idle");
      if (closeEvent.code !== 1000) {
        const reason = closeEvent.code === 1006 ? "Connection to GramSetu was lost." : `Disconnected (${closeEvent.code}).`;
        setStatus(reason);
        term.writeln(`\r\n\x1b[38;5;153m${reason}\x1b[0m`);
      } else {
        term.writeln("\r\n\x1b[38;5;153mSession ended.\x1b[0m");
      }
    };
  }

  function disconnect() {
    socketRef.current?.close(1000);
  }

  const busy = phase === "connecting" || phase === "connected";

  return (
    <section className="page page-wide">
      <PageHead
        eyebrow="Diagnostics"
        title="Remote shell"
        lede="SSH into a speaker's Raspberry Pi from the browser. The connection runs through the speaker's own link to GramSetu, so it works behind mobile data and routers with no open ports."
      />
      <div className="shell-layout">
        <form className="panel shell-login" onSubmit={connect}>
          <Field label="Speaker">
            <select value={speakerId} onChange={(event) => selectSpeaker(event.target.value)} disabled={busy}>
              <option value="">Choose a speaker</option>
              {speakers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.connected}>
                  {item.name} ({item.area?.name}){item.connected ? "" : " · offline"}
                </option>
              ))}
            </select>
          </Field>
          {speaker && !speaker.connected ? <p className="muted">This speaker is offline. A remote shell needs it online.</p> : null}
          {speaker?.connected && speaker.state?.remoteShell === false ? (
            <p className="muted">Remote shell is turned off on this speaker (setup.sh --no-remote-shell).</p>
          ) : null}
          <Field label="Pi username" hint="The Linux user created when the SD card was flashed.">
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" disabled={busy} required />
          </Field>
          <div className="segmented" role="radiogroup" aria-label="Login method">
            <button type="button" className={method === "password" ? "on" : ""} onClick={() => setMethod("password")} disabled={busy}>Password</button>
            <button type="button" className={method === "key" ? "on" : ""} onClick={() => setMethod("key")} disabled={busy}>Private key</button>
          </div>
          {method === "password" ? (
            <Field label="Password">
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" disabled={busy} />
            </Field>
          ) : (
            <>
              <Field label="Private key" hint="OpenSSH or PEM format. It is used for this session only and never stored.">
                <textarea rows={5} value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} spellCheck={false} disabled={busy} />
              </Field>
              <Field label="Key passphrase (if any)">
                <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" disabled={busy} />
              </Field>
            </>
          )}
          <div className="form-actions">
            {phase === "idle" ? (
              <button className="btn primary" type="submit" disabled={!speaker?.connected || !username.trim()}>Connect</button>
            ) : (
              <button className="btn danger" type="button" onClick={disconnect}>Disconnect</button>
            )}
          </div>
          {status ? <p className={`shell-status${phase === "connected" ? " ok" : ""}`}>{status}</p> : null}
          <p className="muted">Sessions close after 30 minutes without typing. Every session is recorded in the speaker's device log.</p>
        </form>
        <div className="panel terminal-panel">
          {!speaker && phase === "idle" ? (
            <div className="terminal-hint">
              <Empty title="No speaker selected" lede="Pick an online speaker on the left." />
            </div>
          ) : null}
          <div className="terminal-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
        </div>
      </div>
    </section>
  );
}
