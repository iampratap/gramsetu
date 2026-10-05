import crypto from "node:crypto";
import { Client } from "ssh2";
import { createWebSocketStream } from "ws";
import { devices } from "./registry.js";
import { serverLog } from "./logs.js";

const OPEN_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_SESSIONS_PER_SPEAKER = 3;

const pendingTunnels = new Map();
const sessionCounts = new Map();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function openTunnel(speakerId) {
  const device = devices.get(speakerId);
  if (!device) return Promise.reject(new Error("Speaker is offline. Remote shell needs a live connection."));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTunnels.delete(id);
      reject(new Error("Speaker did not open the tunnel in time. Is the agent up to date?"));
    }, OPEN_TIMEOUT_MS);
    pendingTunnels.set(id, { speakerId, resolve, reject, timer });
    send(device.ws, { type: "tunnel_open", id });
  });
}

/** Returns the pending tunnel if this speaker was asked to open it. */
export function claimTunnel(id, speakerId) {
  const pending = pendingTunnels.get(id);
  if (!pending || pending.speakerId !== speakerId) return null;
  pendingTunnels.delete(id);
  clearTimeout(pending.timer);
  return pending;
}

export function onTunnel(ws, pending) {
  pending.resolve(ws);
}

export function tunnelFailed(id, speakerId, error) {
  const pending = claimTunnel(String(id || ""), speakerId);
  pending?.reject(new Error(error || "Speaker could not open the tunnel"));
}

function loginError(err) {
  if (err.level === "client-authentication") return "Login failed: wrong username, password, or key.";
  if (err.level === "client-timeout") return "The speaker's SSH server did not answer in time.";
  if (/passphrase|private key|Cannot parse/i.test(err.message || "")) return `Key problem: ${err.message}`;
  return `SSH error: ${err.message || err}`;
}

function minutes(ms) {
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function onTerminal(ws, user, speaker) {
  let tunnel = null;
  let ssh = null;
  let shell = null;
  let counted = false;
  let started = false;
  let closed = false;
  let openedAt = 0;
  let login = "";
  let idleTimer = null;

  const status = (message, extra = {}) => send(ws, { type: "status", message, ...extra });

  const bump = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      status("Closed after 30 minutes without input.");
      cleanup();
    }, IDLE_TIMEOUT_MS);
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    if (counted) sessionCounts.set(speaker.id, Math.max(0, (sessionCounts.get(speaker.id) || 1) - 1));
    try {
      shell?.close();
    } catch {}
    try {
      ssh?.end();
    } catch {}
    try {
      tunnel?.close();
    } catch {}
    if (openedAt) {
      serverLog(speaker, "INFO", `SSH session for ${login} by ${user.name} <${user.email}> closed after ${minutes(Date.now() - openedAt)}`, "server.ssh").catch(() => {});
    }
    send(ws, { type: "closed" });
    if (ws.readyState === ws.OPEN) ws.close(1000);
  }

  async function start(options) {
    const username = String(options.username || "").trim();
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(username)) {
      status("Enter a valid Linux username, e.g. pi.");
      return cleanup();
    }
    if ((sessionCounts.get(speaker.id) || 0) >= MAX_SESSIONS_PER_SPEAKER) {
      status(`This speaker already has ${MAX_SESSIONS_PER_SPEAKER} open shells. Close one first.`);
      return cleanup();
    }
    counted = true;
    sessionCounts.set(speaker.id, (sessionCounts.get(speaker.id) || 0) + 1);
    login = username;

    status("Opening a tunnel to the speaker…");
    try {
      tunnel = await openTunnel(speaker.id);
    } catch (err) {
      status(err.message);
      return cleanup();
    }
    if (closed) return tunnel.close();
    tunnel.on("close", () => {
      if (!closed) {
        status("The speaker closed the connection.");
        cleanup();
      }
    });
    const sock = createWebSocketStream(tunnel);
    sock.on("error", () => {});

    status(`Logging in as ${username}…`);
    const password = typeof options.password === "string" ? options.password : "";
    const privateKey = typeof options.privateKey === "string" && options.privateKey.trim() ? options.privateKey : undefined;
    ssh = new Client();
    ssh.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)));
    ssh.on("ready", () => {
      const cols = Math.min(500, Math.max(20, Number(options.cols) || 80));
      const rows = Math.min(200, Math.max(5, Number(options.rows) || 24));
      ssh.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
        if (err) {
          status(`Could not start a shell: ${err.message}`);
          return cleanup();
        }
        shell = stream;
        openedAt = Date.now();
        serverLog(speaker, "INFO", `SSH session opened for ${username} by ${user.name} <${user.email}>`, "server.ssh").catch(() => {});
        status(`Connected to ${speaker.name} as ${username}.`, { connected: true });
        bump();
        const forward = (chunk) => {
          if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
        };
        stream.on("data", forward);
        stream.stderr.on("data", forward);
        stream.on("close", () => {
          status("Shell closed.");
          cleanup();
        });
      });
    });
    ssh.on("error", (err) => {
      if (err.level === "client-authentication") {
        serverLog(speaker, "WARNING", `SSH login failed for ${username} by ${user.name} <${user.email}>`, "server.ssh").catch(() => {});
      }
      status(loginError(err));
      cleanup();
    });
    ssh.on("close", () => cleanup());
    try {
      ssh.connect({
        sock,
        username,
        password: password || undefined,
        privateKey,
        passphrase: typeof options.passphrase === "string" && options.passphrase ? options.passphrase : undefined,
        tryKeyboard: Boolean(password),
        readyTimeout: 20_000,
        keepaliveInterval: 20_000,
      });
    } catch (err) {
      status(loginError(err));
      cleanup();
    }
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "connect" && !started) {
      started = true;
      start(message).catch((err) => {
        status(`Remote shell failed: ${err.message}`);
        cleanup();
      });
    } else if (message.type === "data" && shell && typeof message.data === "string") {
      shell.write(message.data);
      bump();
    } else if (message.type === "resize" && shell) {
      const cols = Math.min(500, Math.max(20, Number(message.cols) || 80));
      const rows = Math.min(200, Math.max(5, Number(message.rows) || 24));
      shell.setWindow(rows, cols, 0, 0);
    }
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  status("Ready. Enter the speaker's SSH login.");
}
