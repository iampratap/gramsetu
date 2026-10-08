import { prisma } from "../db.js";
import { canBroadcast, canControlSpeaker } from "../lib/http.js";
import { devices } from "./registry.js";

export const BROADCAST_SAMPLE_RATE = 16_000;
const MAX_SPEAKERS = 100;
const MAX_DURATION_MS = 60 * 60_000;
const MAX_FRAME_BYTES = 64 * 1024;
// A speaker on a slow link drops audio instead of falling further and further behind.
const MAX_DEVICE_BACKLOG = 256 * 1024;

const sessions = new Map();
const speakerSessions = new Map();

function send(ws, message) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function speakerView(session, speakerId) {
  const target = session.targets.get(speakerId);
  return { id: speakerId, name: target.name, area: target.area, status: target.status, error: target.error || null };
}

function notify(session, speakerId) {
  send(session.ws, { type: "speaker", speaker: speakerView(session, speakerId) });
}

function join(session, speakerId) {
  const target = session.targets.get(speakerId);
  const device = devices.get(speakerId);
  target.error = null;
  if (!device) {
    target.status = "offline";
    return;
  }
  const other = speakerSessions.get(speakerId);
  if (other && other !== session.id) {
    target.status = "busy";
    target.error = "Already in another broadcast";
    return;
  }
  speakerSessions.set(speakerId, session.id);
  target.status = "joining";
  send(device.ws, {
    type: "broadcast_start",
    id: session.id,
    title: session.title,
    from: session.user.name,
    sampleRate: BROADCAST_SAMPLE_RATE,
    format: "s16le",
    channels: 1,
  });
}

function leave(session, speakerId, status, error) {
  const target = session.targets.get(speakerId);
  if (speakerSessions.get(speakerId) === session.id) speakerSessions.delete(speakerId);
  target.status = status;
  target.error = error || null;
}

async function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.limitTimer);
  sessions.delete(session.id);
  for (const [speakerId, target] of session.targets) {
    if (speakerSessions.get(speakerId) !== session.id) continue;
    send(devices.get(speakerId)?.ws, { type: "broadcast_end", id: session.id });
    leave(session, speakerId, target.status === "playing" ? "completed" : target.status === "joining" ? "cancelled" : target.status);
  }
  const results = Object.fromEntries([...session.targets].map(([id]) => [id, speakerView(session, id)]));
  send(session.ws, { type: "ended", reason, results });
  await prisma.broadcast
    .update({
      where: { id: session.id },
      data: { endedAt: new Date(), durationMs: Date.now() - session.startedAt, results },
    })
    .catch((err) => console.error("broadcast save failed", err));
}

async function startSession(ws, user, message) {
  if (!canBroadcast(user)) return send(ws, { type: "error", message: "Only admins can start a live broadcast" });
  const ids = [...new Set(Array.isArray(message.speakerIds) ? message.speakerIds.map(String) : [])];
  if (ids.length === 0) return send(ws, { type: "error", message: "Choose at least one speaker" });
  if (ids.length > MAX_SPEAKERS) return send(ws, { type: "error", message: `Choose at most ${MAX_SPEAKERS} speakers` });
  const speakers = await prisma.speaker.findMany({
    where: { id: { in: ids } },
    include: { area: { select: { id: true, name: true } } },
  });
  if (speakers.length !== ids.length) return send(ws, { type: "error", message: "Some speakers no longer exist. Reload the page." });
  if (speakers.some((speaker) => !canControlSpeaker(user, speaker))) {
    return send(ws, { type: "error", message: "You can only broadcast to speakers in your area" });
  }

  const title = String(message.title || "").trim().slice(0, 120) || "Live announcement";
  const record = await prisma.broadcast.create({
    data: {
      title,
      createdById: user.id,
      areaIds: [...new Set(speakers.map((speaker) => speaker.areaId))],
      speakerIds: ids,
    },
  });
  const session = {
    id: record.id,
    ws,
    user,
    title,
    startedAt: Date.now(),
    ended: false,
    bytes: 0,
    targets: new Map(speakers.map((speaker) => [speaker.id, { name: speaker.name, area: speaker.area?.name, status: "pending" }])),
  };
  sessions.set(session.id, session);
  for (const speaker of speakers) join(session, speaker.id);
  session.limitTimer = setTimeout(() => endSession(session, "Broadcasts are limited to 60 minutes"), MAX_DURATION_MS);
  send(ws, {
    type: "started",
    id: session.id,
    title,
    sampleRate: BROADCAST_SAMPLE_RATE,
    speakers: speakers.map((speaker) => speakerView(session, speaker.id)),
  });
  return session;
}

function relay(session, frame) {
  if (session.ended || frame.length === 0 || frame.length > MAX_FRAME_BYTES || frame.length % 2) return;
  session.bytes += frame.length;
  for (const [speakerId, target] of session.targets) {
    if (target.status !== "playing" && target.status !== "joining") continue;
    const device = devices.get(speakerId);
    if (!device || device.ws.bufferedAmount > MAX_DEVICE_BACKLOG) continue;
    device.ws.send(frame, { binary: true });
  }
}

export function onBroadcaster(ws, user) {
  let session = null;
  let starting = false;
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (session) relay(session, raw);
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "start" && !session && !starting) {
      starting = true;
      startSession(ws, user, message)
        .then((created) => {
          session = created || null;
          if (ws.readyState !== ws.OPEN && session) endSession(session, "Broadcaster left");
        })
        .catch((err) => {
          console.error("broadcast start failed", err);
          send(ws, { type: "error", message: "Could not start the broadcast" });
        })
        .finally(() => {
          starting = false;
        });
    } else if (message.type === "stop" && session) {
      endSession(session, "Ended by broadcaster");
    } else if (message.type === "retry" && session && session.targets.has(String(message.speakerId))) {
      const speakerId = String(message.speakerId);
      if (!["joining", "playing"].includes(session.targets.get(speakerId).status)) {
        join(session, speakerId);
        notify(session, speakerId);
      }
    }
  });
  ws.on("close", () => {
    if (session) endSession(session, "Broadcaster left");
  });
}

/** A speaker reported how its part of a broadcast is going. */
export function broadcastDeviceState(speakerId, message) {
  const session = sessions.get(String(message.id || ""));
  if (!session || !session.targets.has(speakerId) || speakerSessions.get(speakerId) !== session.id) return;
  const target = session.targets.get(speakerId);
  if (message.state === "playing") {
    target.status = "playing";
    target.error = null;
  } else if (message.state === "failed") {
    leave(session, speakerId, "failed", String(message.error || "Speaker could not play the broadcast").slice(0, 200));
  } else if (message.state === "ended") {
    leave(session, speakerId, "stopped", String(message.error || "Stopped on the speaker").slice(0, 200));
  }
  notify(session, speakerId);
}

export function broadcastDeviceLeft(speakerId) {
  const session = sessions.get(speakerSessions.get(speakerId));
  if (!session) return;
  leave(session, speakerId, "dropped", "Speaker lost its connection");
  notify(session, speakerId);
}

/** Speakers that reconnect during a broadcast they were part of rejoin it. */
export function broadcastDeviceJoined(speakerId) {
  for (const session of sessions.values()) {
    const target = session.targets.get(speakerId);
    if (target && ["offline", "dropped"].includes(target.status)) {
      join(session, speakerId);
      notify(session, speakerId);
    }
  }
}
