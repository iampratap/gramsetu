import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  HttpError,
  areaWhere,
  canCreateAnnouncements,
  canEditAnnouncement,
  canPauseAnnouncement,
  canReviewAnnouncement,
  isGlobal,
  parse,
  userBrief,
} from "../lib/http.js";
import { deleteAudioObject, s3Bucket } from "../lib/s3.js";
import { audioUpload, ingestNormalizedAudio, removeUpload } from "../lib/upload.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";
import { requestSync } from "../realtime/hub.js";

const router = Router();
router.use(requireAuth);

const include = {
  area: { select: { id: true, name: true, code: true } },
  audioFile: {
    select: {
      id: true,
      title: true,
      mimeType: true,
      sizeBytes: true,
      sampleRate: true,
      bitDepth: true,
      channels: true,
    },
  },
  createdBy: userBrief,
  reviewedBy: userBrief,
  deliveries: {
    include: {
      speaker: { select: { id: true, name: true, location: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  },
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must look like 2026-10-04");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times must look like 08:30");

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Lists arrive as JSON from the API or as repeated/comma-separated multipart fields. */
function readList(raw) {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
  const items = [];
  for (const value of values) {
    if (typeof value !== "string") {
      items.push(value);
      continue;
    }
    const text = value.trim();
    if (!text) continue;
    if (text.startsWith("[")) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(400, "A list field is not valid JSON");
      }
      if (Array.isArray(parsed)) items.push(...parsed);
      continue;
    }
    items.push(...text.split(",").map((item) => item.trim()).filter(Boolean));
  }
  return items;
}

const bodySchema = z.object({
  title: z.string().trim().min(3, "Give the announcement a title").max(200),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  audioFileId: z.string().trim().optional().or(z.literal("")),
  audioTitle: z.string().trim().optional().or(z.literal("")),
  areaId: z.string().trim().optional().or(z.literal("")),
  repeat: z.enum(["NOW", "ONCE", "DAILY", "WEEKLY"]).default("NOW"),
  startDate: day.optional().nullable().or(z.literal("")),
  endDate: day.optional().nullable().or(z.literal("")),
  times: z.array(clock).max(24, "Use 24 play times or fewer"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
  timezone: z.string().trim().refine(validTimezone, "Unknown timezone").default("Asia/Kolkata"),
  speakerIds: z.array(z.string().trim().min(1)).min(1, "Choose at least one speaker"),
  approve: z.boolean().default(false),
});

function readBody(raw) {
  const body = parse(bodySchema, {
    ...raw,
    repeat: raw.repeat || "NOW",
    timezone: raw.timezone || "Asia/Kolkata",
    times: readList(raw.times).map(String),
    daysOfWeek: readList(raw.daysOfWeek).map(Number),
    speakerIds: [...new Set(readList(raw.speakerIds).map(String))],
    approve: raw.approve === true || raw.approve === "true",
  });

  if (body.repeat === "NOW") {
    return { ...body, startDate: null, endDate: null, times: [], daysOfWeek: [] };
  }
  if (!body.startDate) throw new HttpError(400, body.repeat === "ONCE" ? "Choose the date to play on" : "Choose a start date");
  const times = [...new Set(body.times)].sort();
  if (times.length === 0) throw new HttpError(400, "Add at least one play time");
  const daysOfWeek = body.repeat === "WEEKLY" ? [...new Set(body.daysOfWeek)].sort() : [];
  if (body.repeat === "WEEKLY" && daysOfWeek.length === 0) throw new HttpError(400, "Pick at least one weekday");
  const endDate = body.repeat === "ONCE" ? null : body.endDate || null;
  if (endDate && endDate < body.startDate) throw new HttpError(400, "End date must be on or after the start date");
  return { ...body, times, daysOfWeek, endDate };
}

/** Delivery status once approved: instant ones are queued, timed ones live in the speaker's schedule. */
function approvedStatus(repeat) {
  return repeat === "NOW" ? "QUEUED" : "SCHEDULED";
}

function reviewData(user, decision, note) {
  return { status: decision, reviewedById: user.id, reviewNote: note || null, reviewedAt: new Date() };
}

/**
 * Validates the form, stores an uploaded file if there is one, and hands the result to `save`.
 * An uploaded file is removed again if saving fails.
 */
async function withAnnouncementInput(req, existing, save) {
  let createdAudioId = null;
  let storedKey = null;
  let committed = false;
  try {
    const body = readBody(req.body);
    const areaId = isGlobal(req.user) ? body.areaId || existing?.areaId : req.user.areaId;
    if (!areaId) throw new HttpError(400, isGlobal(req.user) ? "Choose an area" : "Your account is not assigned to an area");
    const area = await prisma.area.findUnique({ where: { id: areaId } });
    if (!area?.isActive) throw new HttpError(400, "That area is not active");

    const speakers = await prisma.speaker.findMany({
      where: { id: { in: body.speakerIds }, areaId, isActive: true },
    });
    if (speakers.length !== body.speakerIds.length) throw new HttpError(400, "Choose active speakers from the announcement's area");

    let audioFileId = body.audioFileId || "";
    if (req.file) {
      const stored = await ingestNormalizedAudio({ file: req.file, areaCode: area.code });
      storedKey = stored.s3Key;
      const created = await prisma.audioFile.create({
        data: {
          areaId,
          title: body.audioTitle || req.file.originalname,
          originalName: stored.originalName,
          s3Key: stored.s3Key,
          s3Bucket,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sampleRate: stored.sampleRate,
          bitDepth: stored.bitDepth,
          channels: stored.channels,
          uploadedById: req.user.id,
        },
      });
      createdAudioId = created.id;
      audioFileId = created.id;
    }
    if (!audioFileId) throw new HttpError(400, "Choose an audio file or upload a new one");
    const audio = await prisma.audioFile.findUnique({ where: { id: audioFileId } });
    if (!audio || audio.areaId !== areaId) throw new HttpError(400, "That audio file is not in the area's collection");

    const approve = body.approve && isGlobal(req.user);
    const result = await save({
      approve,
      speakerIds: body.speakerIds,
      deliveryStatus: approve ? approvedStatus(body.repeat) : "HOLD",
      data: {
        areaId,
        audioFileId,
        title: body.title,
        notes: body.notes || null,
        repeat: body.repeat,
        startDate: body.startDate,
        endDate: body.endDate,
        times: body.times,
        daysOfWeek: body.daysOfWeek,
        timezone: body.timezone,
        ...(approve
          ? reviewData(req.user, "APPROVED", existing ? "Edited and approved by an admin." : "Created and approved by an admin.")
          : { status: "PENDING", reviewedById: null, reviewNote: null, reviewedAt: null }),
      },
    });
    committed = true;
    return result;
  } finally {
    if (!committed) {
      if (createdAudioId) await prisma.audioFile.delete({ where: { id: createdAudioId } }).catch(() => {});
      if (storedKey) await deleteAudioObject(storedKey).catch(() => {});
      removeUpload(req.file?.filename);
    }
  }
}

async function findAnnouncement(id) {
  const announcement = await prisma.announcement.findUnique({ where: { id }, include: { deliveries: true } });
  if (!announcement) throw new HttpError(404, "Announcement not found");
  return announcement;
}

function assertVisible(user, announcement) {
  if (!isGlobal(user) && announcement.areaId !== user.areaId) {
    throw new HttpError(403, "That announcement is outside your area");
  }
}

router.get(
  "/",
  wrap(async (req, res) => {
    const where = { ...areaWhere(req.user) };
    if (isGlobal(req.user) && req.query.areaId) where.areaId = String(req.query.areaId);
    const status = String(req.query.status || "").trim();
    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) where.status = status;
    if (status === "PAUSED") {
      where.status = "APPROVED";
      where.isActive = false;
    }
    const plays = String(req.query.plays || "");
    if (plays === "now") where.repeat = "NOW";
    if (plays === "scheduled") where.repeat = { not: "NOW" };
    if (req.query.speakerId) where.deliveries = { some: { speakerId: String(req.query.speakerId) } };
    const q = String(req.query.q || "").trim();
    if (q) where.title = { contains: q, mode: "insensitive" };

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (from || to) {
      where.createdAt = {};
      if (from) {
        const start = new Date(`${from}T00:00:00.000`);
        if (Number.isNaN(start.getTime())) throw new HttpError(400, "From date is invalid");
        where.createdAt.gte = start;
      }
      if (to) {
        const end = new Date(`${to}T23:59:59.999`);
        if (Number.isNaN(end.getTime())) throw new HttpError(400, "To date is invalid");
        where.createdAt.lte = end;
      }
    }

    const { page, pageSize, skip, take } = readPage(req.query);
    const [total, announcements] = await Promise.all([
      prisma.announcement.count({ where }),
      prisma.announcement.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }),
    ]);
    res.json({ announcements, meta: pageMeta({ page, pageSize, total }) });
  }),
);

router.post(
  "/",
  audioUpload.single("file"),
  wrap(async (req, res) => {
    if (!canCreateAnnouncements(req.user)) {
      removeUpload(req.file?.filename);
      throw new HttpError(403, "Only makers and admins can create announcements");
    }
    const { announcement, speakerIds, approve } = await withAnnouncementInput(req, null, async (input) => ({
      ...input,
      announcement: await prisma.announcement.create({
        data: {
          ...input.data,
          createdById: req.user.id,
          deliveries: { create: input.speakerIds.map((speakerId) => ({ speakerId, status: input.deliveryStatus })) },
        },
        include,
      }),
    }));
    if (approve) requestSync(speakerIds);
    res.status(201).json({ announcement });
  }),
);

router.put(
  "/:id",
  audioUpload.single("file"),
  wrap(async (req, res) => {
    const existing = await findAnnouncement(req.params.id).catch((err) => {
      removeUpload(req.file?.filename);
      throw err;
    });
    if (!canEditAnnouncement(req.user, existing)) {
      removeUpload(req.file?.filename);
      throw new HttpError(403, "You cannot edit this announcement");
    }
    const { announcement, speakerIds, approve } = await withAnnouncementInput(req, existing, async (input) => ({
      ...input,
      announcement: await prisma.$transaction(async (tx) => {
        await tx.announcementDelivery.deleteMany({ where: { announcementId: existing.id } });
        return tx.announcement.update({
          where: { id: existing.id },
          data: {
            ...input.data,
            deliveries: { create: input.speakerIds.map((speakerId) => ({ speakerId, status: input.deliveryStatus })) },
          },
          include,
        });
      }),
    }));
    // Speakers drop it until it is approved again; approved edits go out right away.
    const previous = existing.deliveries.map((delivery) => delivery.speakerId);
    requestSync(approve ? [...previous, ...speakerIds] : previous);
    res.json({ announcement });
  }),
);

router.post(
  "/:id/review",
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        decision: z.enum(["APPROVED", "REJECTED"]),
        note: z.string().trim().max(500).optional().or(z.literal("")),
      }),
      req.body,
    );
    if (body.decision === "REJECTED" && !body.note) {
      throw new HttpError(400, "Add a note explaining the rejection");
    }

    const existing = await findAnnouncement(req.params.id);
    assertVisible(req.user, existing);
    if (!canReviewAnnouncement(req.user, existing)) {
      throw new HttpError(403, existing.createdById === req.user.id ? "You cannot review an announcement you created" : "You cannot review this announcement");
    }
    if (existing.status !== "PENDING") throw new HttpError(400, "This announcement has already been reviewed");

    const announcement = await prisma.$transaction(async (tx) => {
      await tx.announcementDelivery.updateMany({
        where: { announcementId: existing.id, status: "HOLD" },
        data: { status: body.decision === "APPROVED" ? approvedStatus(existing.repeat) : "CANCELLED" },
      });
      return tx.announcement.update({
        where: { id: existing.id },
        data: reviewData(req.user, body.decision, body.note),
        include,
      });
    });

    if (body.decision === "APPROVED") requestSync(existing.deliveries.map((delivery) => delivery.speakerId));
    res.json({ announcement });
  }),
);

router.post(
  "/:id/active",
  wrap(async (req, res) => {
    const body = parse(z.object({ isActive: z.boolean() }), req.body);
    const existing = await findAnnouncement(req.params.id);
    assertVisible(req.user, existing);
    if (!canPauseAnnouncement(req.user, existing)) throw new HttpError(403, "You cannot pause or resume announcements");
    const announcement = await prisma.announcement.update({
      where: { id: existing.id },
      data: { isActive: body.isActive },
      include,
    });
    requestSync(existing.deliveries.map((delivery) => delivery.speakerId));
    res.json({ announcement });
  }),
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    const existing = await findAnnouncement(req.params.id);
    assertVisible(req.user, existing);
    if (!canEditAnnouncement(req.user, existing)) throw new HttpError(403, "You cannot delete this announcement");
    await prisma.announcement.delete({ where: { id: existing.id } });
    requestSync(existing.deliveries.map((delivery) => delivery.speakerId));
    res.json({ ok: true });
  }),
);

export default router;
