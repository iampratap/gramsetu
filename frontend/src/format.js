import { useEffect, useState } from "react";

export const ROLE_LABEL = {
  SUPERADMIN: "Super admin",
  ADMIN: "Admin",
  MAKER: "Maker",
  CHECKER: "Checker",
};

export const STATUS_LABEL = {
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  HOLD: "Awaiting review",
  QUEUED: "Queued",
  SCHEDULED: "Scheduled",
  SENT: "Sent",
  ACKNOWLEDGED: "Played",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  ONLINE: "Online",
  OFFLINE: "Offline",
  MAINTENANCE: "Maintenance",
  RETIRED: "Retired",
  COMPLETED: "Played",
  SKIPPED: "Skipped",
  STOPPED: "Stopped",
  SCHEDULE: "Scheduled announcement",
  ANNOUNCEMENT: "Announcement",
  NOW: "Right after approval",
  LIVE_TEST: "Live test",
  BROADCAST: "Live broadcast",
  broadcast: "On air",
  ONCE: "Once",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  playing: "Playing",
  paused: "Paused",
  idle: "Idle",
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatClock(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
  return formatClock(ms / 1000);
}

export function describePlan(schedule) {
  if (schedule.repeat === "NOW") return "Right after approval";
  const times = schedule.times.join(", ");
  if (schedule.repeat === "ONCE") return `Once on ${schedule.startDate} at ${times}`;
  const range = schedule.endDate ? ` until ${schedule.endDate}` : "";
  if (schedule.repeat === "WEEKLY") {
    const days = schedule.daysOfWeek.map((day) => WEEKDAYS[day]).join(", ");
    return `${days} at ${times}${range}`;
  }
  return `Daily at ${times}${range}`;
}

export function formatWhen(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** "2d 03:04:05", "03:04:05" or "04:05" until a moment that is `ms` away. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${hours || days ? `${pad(hours)}:` : ""}${pad(minutes)}:${pad(total % 60)}`;
  return days ? `${days}d ${clock}` : clock;
}
