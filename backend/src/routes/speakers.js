import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  HttpError,
  assertAreaAccess,
  canControlSpeaker,
  canManageMasters,
  isGlobal,
  parse,
  presentSpeaker,
} from "../lib/http.js";
import { requireAuth, wrap } from "../middleware/auth.js";
import { disconnectDevice, liveView, sendCommand, speakerChanged } from "../realtime/hub.js";

const router = Router();
router.use(requireAuth);

const speakerSchema = z.object({
  areaId: z.string().trim().optional().or(z.literal("")),
  name: z.string().trim().min(2, "Speaker name is required"),
  location: z.string().trim().min(2, "Location is required"),
  deviceId: z.string().trim().max(64).optional().or(z.literal("")),
  status: z.enum(["ONLINE", "OFFLINE", "MAINTENANCE"]).optional(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

router.get(
  "/",
  wrap(async (req, res) => {
    const where = {};
    if (req.user.role === "SUPERADMIN" || req.user.role === "ADMIN") {
      if (req.query.areaId) where.areaId = String(req.query.areaId);
    } else {
      where.areaId = req.user.areaId;
    }
    const q = String(req.query.q || "").trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
        { deviceId: { contains: q, mode: "insensitive" } },
      ];
    }
    const speakers = await prisma.speaker.findMany({
      where,
      include: { area: { select: { id: true, name: true, code: true } } },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });
    res.json({ speakers: speakers.map((speaker) => presentSpeaker(speaker, req.user)) });
  }),
);

router.get(
  "/live",
  wrap(async (req, res) => {
    const speakers = await prisma.speaker.findMany({
      where: isGlobal(req.user) ? {} : { areaId: req.user.areaId },
      include: { area: { select: { id: true, name: true, code: true } } },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });
    res.json({ speakers: speakers.map(liveView) });
  }),
);

const commandSchema = z.object({
  action: z.enum([
    "play",
    "pause",
    "resume",
    "stop",
    "skip",
    "volume_up",
    "volume_down",
    "volume_set",
    "play_audio",
    "sync",
  ]),
  value: z.number().int().min(0).max(100).optional(),
  audioFileId: z.string().trim().optional(),
});

router.post(
  "/:id/command",
  wrap(async (req, res) => {
    const body = parse(commandSchema, req.body);
    const speaker = await prisma.speaker.findUnique({ where: { id: req.params.id } });
    if (!speaker) throw new HttpError(404, "Speaker not found");
    if (!canControlSpeaker(req.user, speaker)) throw new HttpError(403, "That speaker is outside your area");

    const command = { action: body.action };
    let timeout = 10_000;
    if (body.action === "volume_set") {
      if (body.value === undefined) throw new HttpError(400, "Give a volume between 0 and 100");
      command.value = body.value;
    }
    if (body.action === "play_audio") {
      if (!body.audioFileId) throw new HttpError(400, "Choose an audio file to test");
      const audio = await prisma.audioFile.findUnique({ where: { id: body.audioFileId } });
      if (!audio || audio.areaId !== speaker.areaId) {
        throw new HttpError(400, "Choose an audio file from the speaker's area");
      }
      command.audio = { id: audio.id, title: audio.title, sizeBytes: audio.sizeBytes, url: `/api/device/audio/${audio.id}` };
      // The speaker may have to download the file first.
      timeout = 60_000;
    }

    const result = await sendCommand(speaker.id, command, timeout);
    res.json({ ok: true, message: result.message || null, state: result.state || null });
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    if (!canManageMasters(req.user)) throw new HttpError(403, "You cannot add speakers");
    const body = parse(speakerSchema, req.body);
    const areaId = body.areaId;
    if (!areaId) throw new HttpError(400, "Choose an area");
    assertAreaAccess(req.user, areaId);
    const area = await prisma.area.findUnique({ where: { id: areaId } });
    if (!area || !area.isActive) throw new HttpError(400, "Choose an active area");

    const deviceId = body.deviceId || `spk-${area.code.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`;
    const speaker = await prisma.speaker.create({
      data: {
        areaId,
        name: body.name,
        location: body.location,
        deviceId,
        deviceKey: crypto.randomBytes(18).toString("hex"),
        status: body.status || "OFFLINE",
        notes: body.notes || null,
        isActive: body.isActive ?? true,
      },
      include: { area: { select: { id: true, name: true, code: true } } },
    });
    await speakerChanged(speaker.id);
    res.status(201).json({ speaker: presentSpeaker(speaker, req.user) });
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    if (!canManageMasters(req.user)) throw new HttpError(403, "You cannot change speakers");
    const body = parse(speakerSchema.partial(), req.body);
    const existing = await prisma.speaker.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Speaker not found");
    assertAreaAccess(req.user, existing.areaId);

    let areaId = existing.areaId;
    if (body.areaId) {
      assertAreaAccess(req.user, body.areaId);
      const area = await prisma.area.findUnique({ where: { id: body.areaId } });
      if (!area) throw new HttpError(400, "Area not found");
      areaId = area.id;
    }

    const speaker = await prisma.speaker.update({
      where: { id: existing.id },
      data: {
        areaId,
        ...("name" in body ? { name: body.name } : {}),
        ...("location" in body ? { location: body.location } : {}),
        ...("deviceId" in body && body.deviceId ? { deviceId: body.deviceId } : {}),
        ...("status" in body ? { status: body.status } : {}),
        ...("notes" in body ? { notes: body.notes || null } : {}),
        ...("isActive" in body ? { isActive: body.isActive } : {}),
      },
      include: { area: { select: { id: true, name: true, code: true } } },
    });
    await speakerChanged(speaker.id);
    res.json({ speaker: presentSpeaker(speaker, req.user) });
  }),
);

router.post(
  "/:id/roll-key",
  wrap(async (req, res) => {
    if (!canManageMasters(req.user)) throw new HttpError(403, "You cannot change speakers");
    const existing = await prisma.speaker.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Speaker not found");
    assertAreaAccess(req.user, existing.areaId);
    const speaker = await prisma.speaker.update({
      where: { id: existing.id },
      data: { deviceKey: crypto.randomBytes(18).toString("hex") },
      include: { area: { select: { id: true, name: true, code: true } } },
    });
    disconnectDevice(speaker.id, "Device key was changed");
    res.json({ speaker: presentSpeaker(speaker, req.user) });
  }),
);

export default router;
