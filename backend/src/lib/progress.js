import { prisma } from "../db.js";
import { isDeviceConnected } from "../realtime/registry.js";
import { nextOccurrence, previousOccurrence } from "./schedule.js";

// A timed play counts as missed once this long has passed without a report (the speaker allows 10 minutes late).
const MISSED_AFTER_MS = 15 * 60 * 1000;

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * Per-speaker progress of each announcement:
 * WAITING_APPROVAL, NOT_SENT (rejected), PAUSED, PENDING, DOWNLOADED, PLAYED or NOT_PLAYED.
 */
export async function attachProgress(announcements, now = Date.now()) {
  const timedIds = announcements.filter((item) => item.repeat !== "NOW").map((item) => item.id);
  const deliveryIds = announcements.filter((item) => item.repeat === "NOW").flatMap((item) => item.deliveries.map((delivery) => delivery.id));

  const [timedLatest, timedCounts, nowLatest] = await Promise.all([
    timedIds.length
      ? prisma.playLog.findMany({
          where: { scheduleId: { in: timedIds } },
          distinct: ["speakerId", "scheduleId"],
          orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { receivedAt: "desc" }],
        })
      : [],
    timedIds.length
      ? prisma.playLog.groupBy({
          by: ["speakerId", "scheduleId"],
          where: { scheduleId: { in: timedIds }, result: "COMPLETED" },
          _count: { _all: true },
        })
      : [],
    deliveryIds.length
      ? prisma.playLog.findMany({ where: { deliveryId: { in: deliveryIds } }, distinct: ["deliveryId"], orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { receivedAt: "desc" }] })
      : [],
  ]);
  const latestTimed = new Map(timedLatest.map((log) => [`${log.speakerId}:${log.scheduleId}`, log]));
  const countTimed = new Map(timedCounts.map((row) => [`${row.speakerId}:${row.scheduleId}`, row._count._all]));
  const latestNow = new Map(nowLatest.map((log) => [log.deliveryId, log]));

  return announcements.map((announcement) => ({
    ...announcement,
    deliveries: announcement.deliveries.map((delivery) => {
      const key = `${delivery.speakerId}:${announcement.id}`;
      let log = announcement.repeat === "NOW" ? latestNow.get(delivery.id) : latestTimed.get(key);
      // Reports from before an edit belong to the old version.
      const since = delivery.createdAt.getTime();
      if (log && (log.startedAt || log.receivedAt).getTime() < since) log = null;
      return { ...delivery, progress: progressFor(announcement, delivery, log, countTimed.get(key) || 0, now) };
    }),
  }));
}

function progressFor(announcement, delivery, log, playCount, now) {
  const online = isDeviceConnected(delivery.speakerId);
  const base = {
    online,
    receivedAt: iso(delivery.sentAt),
    downloadedAt: iso(delivery.downloadedAt || (log ? log.startedAt : null)),
    lastPlayedAt: null,
    playCount: 0,
    nextAt: null,
    detail: null,
  };
  if (announcement.status === "PENDING") return { ...base, state: "WAITING_APPROVAL", detail: "Sent to the speaker after approval" };
  if (announcement.status === "REJECTED" || delivery.status === "CANCELLED") return { ...base, state: "NOT_SENT", detail: "Rejected, so it was not sent" };

  const lastResult = log
    ? {
        lastPlayedAt: iso(log.endedAt || log.startedAt || log.receivedAt),
        lastResult: log.result,
        lastError: log.error,
        playedOffline: log.playedOffline,
      }
    : {};
  const waitingDetail = (downloaded) =>
    downloaded
      ? null
      : online
        ? "Downloading on the speaker"
        : delivery.sentAt
          ? "Received; download finishes when the speaker is back online"
          : "Speaker is offline; it gets this when it reconnects";

  if (announcement.repeat === "NOW") {
    if (log) {
      const played = log.result === "COMPLETED";
      return {
        ...base,
        ...lastResult,
        playCount: played ? 1 : 0,
        state: played ? "PLAYED" : "NOT_PLAYED",
        detail: played ? (log.playedOffline ? "Played while offline" : null) : notPlayedReason(log),
      };
    }
    const downloaded = Boolean(delivery.downloadedAt);
    return { ...base, state: downloaded ? "DOWNLOADED" : "PENDING", detail: downloaded ? "Waiting for its turn to play" : waitingDetail(false) };
  }

  const nextAt = announcement.isActive ? nextOccurrence(announcement, now) : null;
  const withNext = { ...base, ...lastResult, playCount, nextAt: iso(nextAt) };
  if (!announcement.isActive) return { ...withNext, state: "PAUSED", detail: "Paused; the speaker skips it until resumed" };

  const approvedAt = Math.max(delivery.createdAt.getTime(), announcement.reviewedAt ? announcement.reviewedAt.getTime() : 0);
  const due = previousOccurrence(announcement, now - MISSED_AFTER_MS);
  const missed = due !== null && due >= approvedAt && (!log || !log.scheduledFor || log.scheduledFor.getTime() < due - 60_000);
  if (missed) {
    return {
      ...withNext,
      state: "NOT_PLAYED",
      missedAt: iso(due),
      detail: online ? "No play report for this time" : "No report yet; the speaker is offline and reports when it is back",
    };
  }
  if (log) {
    const played = log.result === "COMPLETED";
    return {
      ...withNext,
      state: played ? "PLAYED" : "NOT_PLAYED",
      detail: played ? (log.playedOffline ? "Last play happened while offline" : null) : notPlayedReason(log),
    };
  }
  const downloaded = Boolean(delivery.downloadedAt);
  return {
    ...withNext,
    state: downloaded ? "DOWNLOADED" : "PENDING",
    detail: downloaded ? (nextAt ? "Stored on the speaker, waiting for its time" : "Stored on the speaker") : waitingDetail(false),
  };
}

function notPlayedReason(log) {
  if (log.error) return log.error;
  if (log.result === "SKIPPED") return "Skipped";
  if (log.result === "STOPPED") return "Stopped before the end";
  return "Could not play";
}
