import { isDeviceConnected } from "../realtime/registry.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join(" ");
    throw new HttpError(400, message || "Invalid input");
  }
  return result.data;
}

export const userBrief = {
  select: { id: true, name: true, email: true, role: true },
};

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    areaId: user.areaId,
    area: user.area
      ? { id: user.area.id, name: user.area.name, code: user.area.code }
      : null,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

export function isGlobal(user) {
  return user.role === "SUPERADMIN" || user.role === "ADMIN";
}

export function assertAreaAccess(user, areaId) {
  if (isGlobal(user)) return;
  if (!user.areaId || user.areaId !== areaId) {
    throw new HttpError(403, "That record is outside your area");
  }
}

export function areaWhere(user) {
  if (isGlobal(user)) return {};
  return { areaId: user.areaId };
}

export function canManageMasters(user) {
  return isGlobal(user);
}

export function canUploadAudio(user) {
  return isGlobal(user) || user.role === "MAKER";
}

export function canDeleteAudio(user) {
  return isGlobal(user) || user.role === "MAKER";
}

function inArea(user, areaId) {
  return Boolean(user.areaId) && user.areaId === areaId;
}

export function canCreateAnnouncements(user) {
  return isGlobal(user) || user.role === "MAKER";
}

export function canEditAnnouncement(user, announcement) {
  return isGlobal(user) || (user.role === "MAKER" && inArea(user, announcement.areaId));
}

/** Admins may approve anything, including their own work; checkers only others' work in their area. */
export function canReviewAnnouncement(user, announcement) {
  if (isGlobal(user)) return true;
  return user.role === "CHECKER" && inArea(user, announcement.areaId) && announcement.createdById !== user.id;
}

export function canPauseAnnouncement(user, announcement) {
  return isGlobal(user) || (["MAKER", "CHECKER"].includes(user.role) && inArea(user, announcement.areaId));
}

export function canControlSpeaker(user, speaker) {
  return isGlobal(user) || (Boolean(user.areaId) && user.areaId === speaker.areaId);
}

/** Live broadcast is admin-only (super admin and admin). */
export function canBroadcast(user) {
  return isGlobal(user);
}

export function effectiveSpeakerStatus(speaker) {
  if (!speaker.isActive) return "RETIRED";
  if (speaker.status === "MAINTENANCE") return "MAINTENANCE";
  if (isDeviceConnected(speaker.id)) return "ONLINE";
  if (speaker.status !== "ONLINE") return speaker.status;
  if (!speaker.lastSeenAt) return "OFFLINE";
  const age = Date.now() - new Date(speaker.lastSeenAt).getTime();
  return age > 5 * 60 * 1000 ? "OFFLINE" : "ONLINE";
}

export function presentSpeaker(speaker, user) {
  const view = {
    ...speaker,
    effectiveStatus: effectiveSpeakerStatus(speaker),
    connected: isDeviceConnected(speaker.id),
  };
  if (!canManageMasters(user)) delete view.deviceKey;
  return view;
}
