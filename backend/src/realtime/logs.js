import crypto from "node:crypto";
import { prisma } from "../db.js";

export const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const RETENTION_DAYS = Math.max(1, Number(process.env.DEVICE_LOG_RETENTION_DAYS) || 30);
const BACKLOG_LINES = 300;
const MAX_MESSAGE = 8000;

const viewers = new Set();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function present(row, speaker) {
  return {
    id: row.id,
    localId: row.localId,
    speakerId: speaker.id,
    speakerName: speaker.name,
    level: row.level,
    logger: row.logger,
    message: row.message,
    loggedAt: row.loggedAt instanceof Date ? row.loggedAt.toISOString() : row.loggedAt,
  };
}

function normalize(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.localId !== "string" || !entry.localId) return null;
  const level = String(entry.level || "").toUpperCase();
  const loggedAt = new Date(entry.loggedAt);
  return {
    localId: entry.localId.slice(0, 64),
    level: LOG_LEVELS.includes(level) ? level : level === "WARN" ? "WARNING" : "INFO",
    logger: String(entry.logger || "agent").slice(0, 64),
    message: String(entry.message ?? "").slice(0, MAX_MESSAGE),
    loggedAt: Number.isNaN(loggedAt.getTime()) ? new Date() : loggedAt,
  };
}

function publish(speaker, entries) {
  if (!entries.length) return;
  for (const viewer of viewers) {
    if (viewer.speakerId && viewer.speakerId !== speaker.id) continue;
    send(viewer.ws, { type: "logs", entries });
  }
}

/** Stores a batch from a speaker and returns the localIds that are now safe for it to forget. */
export async function ingestDeviceLogs(speaker, entries) {
  if (!Array.isArray(entries)) return [];
  const rows = entries.slice(0, 500).map(normalize).filter(Boolean);
  if (!rows.length) return [];
  const existing = await prisma.deviceLog.findMany({
    where: { speakerId: speaker.id, localId: { in: rows.map((row) => row.localId) } },
    select: { localId: true },
  });
  const seen = new Set(existing.map((row) => row.localId));
  const fresh = rows.filter((row) => !seen.has(row.localId));
  if (fresh.length) {
    await prisma.deviceLog.createMany({
      data: fresh.map((row) => ({ ...row, speakerId: speaker.id })),
      skipDuplicates: true,
    });
    publish(speaker, fresh.map((row) => present({ ...row, id: row.localId }, speaker)));
  }
  return rows.map((row) => row.localId);
}

/** Records something the server did to a speaker (e.g. an SSH session) in that speaker's log. */
export async function serverLog(speaker, level, message, logger = "server") {
  const row = await prisma.deviceLog.create({
    data: {
      speakerId: speaker.id,
      localId: `srv-${crypto.randomUUID()}`,
      level,
      logger,
      message: message.slice(0, MAX_MESSAGE),
      loggedAt: new Date(),
    },
  });
  publish(speaker, [present(row, speaker)]);
}

export async function onLogViewer(ws, speakerId) {
  const viewer = { ws, speakerId: speakerId || null };
  viewers.add(viewer);
  ws.on("close", () => viewers.delete(viewer));
  const rows = await prisma.deviceLog.findMany({
    where: speakerId ? { speakerId } : {},
    include: { speaker: { select: { id: true, name: true } } },
    orderBy: [{ loggedAt: "desc" }, { receivedAt: "desc" }],
    take: BACKLOG_LINES,
  });
  send(ws, { type: "backlog", entries: rows.reverse().map((row) => present(row, row.speaker)) });
}

export function startLogRetention() {
  const prune = () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    prisma.deviceLog.deleteMany({ where: { loggedAt: { lt: cutoff } } }).catch(() => {});
  };
  prune();
  setInterval(prune, 3_600_000).unref();
}
