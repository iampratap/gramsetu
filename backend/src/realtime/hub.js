import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import { prisma } from "../db.js";
import { authenticateDevice } from "../lib/device-auth.js";
import { HttpError, effectiveSpeakerStatus, isGlobal } from "../lib/http.js";
import { devices } from "./registry.js";
import { ingestDeviceLogs, onLogViewer, startLogRetention } from "./logs.js";
import { claimTunnel, onTerminal, onTunnel, tunnelFailed } from "./terminal.js";
import { broadcastDeviceJoined, broadcastDeviceLeft, broadcastDeviceState, onBroadcaster } from "./broadcast.js";

const viewers = new Set();
const PERSIST_EVERY_MS = 15_000;
const HEARTBEAT_MS = 30_000;

const speakerInclude = { area: { select: { id: true, name: true, code: true } } };

export function liveView(speaker) {
  const device = devices.get(speaker.id);
  return {
    id: speaker.id,
    name: speaker.name,
    location: speaker.location,
    latitude: speaker.latitude ?? null,
    longitude: speaker.longitude ?? null,
    deviceId: speaker.deviceId,
    areaId: speaker.areaId,
    area: speaker.area || null,
    isActive: speaker.isActive,
    status: effectiveSpeakerStatus(speaker),
    connected: Boolean(device),
    lastSeenAt: speaker.lastSeenAt,
    agentVersion: speaker.agentVersion,
    ipAddress: speaker.ipAddress,
    state: device?.state ?? speaker.liveState ?? null,
    stateAt: device?.stateAt ?? speaker.liveStateAt ?? null,
  };
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(areaId, message) {
  for (const viewer of viewers) {
    if (isGlobal(viewer.user) || viewer.user.areaId === areaId) send(viewer.ws, message);
  }
}

async function broadcastSpeaker(speakerId) {
  const device = devices.get(speakerId);
  const speaker = device?.info || (await prisma.speaker.findUnique({ where: { id: speakerId }, include: speakerInclude }));
  if (!speaker) return;
  broadcast(speaker.areaId, { type: "speaker", speaker: liveView(speaker) });
}

const DOWNLOAD_RECHECK_MS = 60_000;

/** Speakers list the audio files they hold; deliveries that use one of them count as downloaded. */
async function markDownloaded(device, cachedAudio) {
  const ids = [...new Set(cachedAudio.slice(0, 1000).map(String))].sort();
  const key = ids.join(",");
  const now = Date.now();
  // The same file can serve a newly approved announcement, so re-check now and then even if the list is unchanged.
  if (key === device.cachedKey && now - (device.cachedCheckedAt || 0) < DOWNLOAD_RECHECK_MS) return;
  device.cachedKey = key;
  device.cachedCheckedAt = now;
  if (!ids.length) return;
  await prisma.announcementDelivery.updateMany({
    where: {
      speakerId: device.info.id,
      downloadedAt: null,
      status: { in: ["QUEUED", "SENT", "SCHEDULED", "ACKNOWLEDGED"] },
      announcement: { audioFileId: { in: ids } },
    },
    data: { downloadedAt: new Date(now) },
  });
}

function remoteIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.headers["x-real-ip"] || req.socket.remoteAddress || null;
}

async function onDevice(ws, speaker, req) {
  const previous = devices.get(speaker.id);
  if (previous) previous.ws.close(4000, "Replaced by a newer connection");

  const device = { ws, info: speaker, state: null, stateAt: null, pending: new Map(), persistedAt: 0 };
  // Listeners must exist before the first await, or the device's opening messages are lost.
  const ready = prisma.speaker
    .update({
      where: { id: speaker.id },
      data: { status: "ONLINE", lastSeenAt: new Date(), ipAddress: remoteIp(req) },
      include: speakerInclude,
    })
    .then((info) => {
      device.info = info;
      device.state ??= info.liveState || null;
      device.stateAt ??= info.liveStateAt;
      devices.set(speaker.id, device);
      broadcastSpeaker(speaker.id);
      broadcastDeviceJoined(speaker.id);
    });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    ready
      .then(() => handleDeviceMessage(device, message))
      .catch((err) => console.error("device message failed", err));
  });

  ws.on("close", async () => {
    await ready.catch(() => {});
    if (devices.get(speaker.id) !== device) return;
    devices.delete(speaker.id);
    broadcastDeviceLeft(speaker.id);
    for (const { reject, timer } of device.pending.values()) {
      clearTimeout(timer);
      reject(new HttpError(409, "Speaker disconnected"));
    }
    await prisma.speaker
      .updateMany({
        where: { id: speaker.id, status: "ONLINE" },
        data: { status: "OFFLINE", liveState: device.state ?? undefined, liveStateAt: device.stateAt ?? undefined },
      })
      .catch(() => {});
    device.info = { ...device.info, status: "OFFLINE" };
    broadcast(device.info.areaId, { type: "speaker", speaker: liveView(device.info) });
  });

  await ready;
}

async function handleDeviceMessage(device, message) {
  const speakerId = device.info.id;
  if (message.type === "hello") {
    device.info = await prisma.speaker.update({
      where: { id: speakerId },
      data: {
        agentVersion: String(message.agentVersion || "").slice(0, 32) || null,
        ...(message.localIp ? { ipAddress: String(message.localIp).slice(0, 64) } : {}),
      },
      include: speakerInclude,
    });
    broadcastSpeaker(speakerId);
    return;
  }

  if (message.type === "state" && message.state && typeof message.state === "object") {
    const { cachedAudio, ...state } = message.state;
    if (Array.isArray(cachedAudio)) await markDownloaded(device, cachedAudio);
    const previousStatus = device.state?.status;
    device.state = state;
    device.stateAt = new Date();
    const now = Date.now();
    if (now - device.persistedAt > PERSIST_EVERY_MS || previousStatus !== message.state.status) {
      device.persistedAt = now;
      device.info = await prisma.speaker.update({
        where: { id: speakerId },
        data: { liveState: device.state, liveStateAt: device.stateAt, lastSeenAt: device.stateAt },
        include: speakerInclude,
      });
    }
    broadcast(device.info.areaId, { type: "speaker", speaker: liveView(device.info) });
    return;
  }

  if (message.type === "logs") {
    const ids = await ingestDeviceLogs(device.info, message.entries);
    send(device.ws, { type: "logs_ack", ids });
    return;
  }

  if (message.type === "broadcast_state") {
    broadcastDeviceState(speakerId, message);
    return;
  }

  if (message.type === "tunnel_error") {
    tunnelFailed(message.id, speakerId, String(message.error || "").slice(0, 300));
    return;
  }

  if (message.type === "command_result" && message.id) {
    const pending = device.pending.get(message.id);
    if (!pending) return;
    device.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message);
    else pending.reject(new HttpError(400, message.error || "Speaker rejected the command"));
  }
}

async function authenticateViewer(token) {
  if (!token) throw new HttpError(401, "Sign in required");
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(401, "Session expired");
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) throw new HttpError(401, "This account is not active");
  return user;
}

async function onViewer(ws, user) {
  const viewer = { ws, user };
  viewers.add(viewer);
  ws.on("close", () => viewers.delete(viewer));
  const speakers = await prisma.speaker.findMany({
    where: isGlobal(user) ? {} : { areaId: user.areaId },
    include: speakerInclude,
    orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
  });
  send(ws, { type: "snapshot", speakers: speakers.map((speaker) => liveView(devices.get(speaker.id)?.info || speaker)) });
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function adminSpeaker(user, speakerId) {
  if (!isGlobal(user)) throw new HttpError(403, "Only super admins and admins can do this");
  if (!speakerId) return null;
  const speaker = await prisma.speaker.findUnique({ where: { id: speakerId } });
  if (!speaker) throw new HttpError(404, "Speaker not found");
  return speaker;
}

export function attachRealtime(server) {
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const liveWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const logWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const broadcastWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const allWss = [deviceWss, liveWss, logWss, terminalWss, tunnelWss, broadcastWss];

  for (const wss of allWss) {
    wss.on("connection", (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
    });
  }

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/ws/device") {
        const speaker = await authenticateDevice(
          req.headers["x-device-id"] || url.searchParams.get("deviceId"),
          req.headers["x-device-key"] || url.searchParams.get("deviceKey"),
        );
        deviceWss.handleUpgrade(req, socket, head, (ws) => {
          deviceWss.emit("connection", ws, req);
          onDevice(ws, speaker, req).catch((err) => {
            console.error("device connect failed", err);
            ws.close(1011, "Server error");
          });
        });
      } else if (url.pathname === "/ws/live") {
        const user = await authenticateViewer(url.searchParams.get("token"));
        liveWss.handleUpgrade(req, socket, head, (ws) => {
          liveWss.emit("connection", ws, req);
          onViewer(ws, user).catch(() => ws.close(1011, "Server error"));
        });
      } else if (url.pathname === "/ws/logs") {
        const user = await authenticateViewer(url.searchParams.get("token"));
        const speaker = await adminSpeaker(user, url.searchParams.get("speakerId"));
        logWss.handleUpgrade(req, socket, head, (ws) => {
          logWss.emit("connection", ws, req);
          onLogViewer(ws, speaker?.id).catch(() => ws.close(1011, "Server error"));
        });
      } else if (url.pathname === "/ws/terminal") {
        const user = await authenticateViewer(url.searchParams.get("token"));
        const speaker = await adminSpeaker(user, url.searchParams.get("speakerId"));
        if (!speaker) throw new HttpError(400, "Choose a speaker");
        terminalWss.handleUpgrade(req, socket, head, (ws) => {
          terminalWss.emit("connection", ws, req);
          onTerminal(ws, user, speaker);
        });
      } else if (url.pathname === "/ws/broadcast") {
        const user = await authenticateViewer(url.searchParams.get("token"));
        broadcastWss.handleUpgrade(req, socket, head, (ws) => {
          broadcastWss.emit("connection", ws, req);
          onBroadcaster(ws, user);
        });
      } else if (url.pathname === "/ws/tunnel") {
        const speaker = await authenticateDevice(
          req.headers["x-device-id"] || url.searchParams.get("deviceId"),
          req.headers["x-device-key"] || url.searchParams.get("deviceKey"),
        );
        const pending = claimTunnel(url.searchParams.get("id") || "", speaker.id);
        if (!pending) throw new HttpError(404, "No tunnel was requested");
        tunnelWss.handleUpgrade(req, socket, head, (ws) => {
          tunnelWss.emit("connection", ws, req);
          onTunnel(ws, pending);
        });
      } else {
        rejectUpgrade(socket, 404, "Not Found");
      }
    } catch (err) {
      const status = err.status || 500;
      const reasons = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 423: "Locked" };
      rejectUpgrade(socket, status, reasons[status] || "Error");
    }
  });

  setInterval(() => {
    for (const wss of allWss) {
      for (const ws of wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_MS).unref();

  // Sockets do not survive a restart, so nothing can still be connected.
  prisma.speaker.updateMany({ where: { status: "ONLINE" }, data: { status: "OFFLINE" } }).catch(() => {});
  prisma.broadcast
    .updateMany({ where: { endedAt: null }, data: { endedAt: new Date() } })
    .catch(() => {});
  startLogRetention();
}

export function sendCommand(speakerId, command, timeoutMs = 10_000) {
  const device = devices.get(speakerId);
  if (!device) throw new HttpError(409, "Speaker is offline. Commands need a live connection.");
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      device.pending.delete(id);
      reject(new HttpError(504, "Speaker did not answer in time"));
    }, timeoutMs);
    device.pending.set(id, { resolve, reject, timer });
    send(device.ws, { type: "command", id, ...command });
  });
}

export function requestSync(speakerIds) {
  for (const speakerId of new Set(speakerIds)) {
    const device = devices.get(speakerId);
    if (device) send(device.ws, { type: "sync" });
  }
}

export async function speakerChanged(speakerId) {
  const info = await prisma.speaker.findUnique({ where: { id: speakerId }, include: speakerInclude });
  const device = devices.get(speakerId);
  if (device && info) {
    device.info = info;
    if (!info.isActive || info.status === "MAINTENANCE") {
      device.ws.close(4001, "Speaker disabled from the server");
    }
  }
  if (info) broadcast(info.areaId, { type: "speaker", speaker: liveView(info) });
}

export function disconnectDevice(speakerId, reason) {
  devices.get(speakerId)?.ws.close(4002, reason);
}

export function publishReports(areaId, reports) {
  for (const report of reports) broadcast(areaId, { type: "report", report });
}
