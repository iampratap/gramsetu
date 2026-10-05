import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  HttpError,
  assertAreaAccess,
  canDeleteAudio,
  canUploadAudio,
  parse,
  userBrief,
} from "../lib/http.js";
import { getAudioObject, deleteAudioObject, s3Bucket } from "../lib/s3.js";
import { audioUpload, ingestNormalizedAudio, removeUpload } from "../lib/upload.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const metaSchema = z.object({
  title: z.string().trim().min(2, "Audio title is required"),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  areaId: z.string().trim().optional().or(z.literal("")),
});

async function streamAudio(res, audio, download) {
  const object = await getAudioObject(audio.s3Key);
  res.setHeader("Content-Type", audio.mimeType || object.contentType || "audio/wav");
  if (object.contentLength) res.setHeader("Content-Length", object.contentLength);
  if (download) {
    const name = audio.originalName?.replace(/\.[^.]+$/, "") || audio.title || "announcement";
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(`${name}.wav`)}"`,
    );
  }
  object.body.pipe(res);
}

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
    if (q) where.title = { contains: q, mode: "insensitive" };
    const { page, pageSize, skip, take } = readPage(req.query);
    const [total, audioFiles] = await Promise.all([
      prisma.audioFile.count({ where }),
      prisma.audioFile.findMany({
        where,
        include: {
          area: { select: { id: true, name: true, code: true } },
          uploadedBy: userBrief,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
    ]);
    res.json({ audioFiles, meta: pageMeta({ page, pageSize, total }) });
  }),
);

router.post(
  "/",
  audioUpload.single("file"),
  wrap(async (req, res) => {
    if (!canUploadAudio(req.user)) {
      removeUpload(req.file?.filename);
      throw new HttpError(403, "Only makers (or platform admins) can upload audio");
    }
    if (!req.file) throw new HttpError(400, "Choose an audio file");
    let storedKey = null;
    try {
      const body = parse(metaSchema, req.body);
      const areaId = req.user.role === "MAKER" ? req.user.areaId : body.areaId;
      if (!areaId) throw new HttpError(400, "Choose an area");
      assertAreaAccess(req.user, areaId);
      const area = await prisma.area.findUnique({ where: { id: areaId } });
      if (!area || !area.isActive) throw new HttpError(400, "Choose an active area");

      const stored = await ingestNormalizedAudio({ file: req.file, areaCode: area.code });
      storedKey = stored.s3Key;
      const audioFile = await prisma.audioFile.create({
        data: {
          areaId,
          title: body.title,
          description: body.description || null,
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
        include: {
          area: { select: { id: true, name: true, code: true } },
          uploadedBy: userBrief,
        },
      });
      res.status(201).json({ audioFile });
    } catch (error) {
      if (storedKey) await deleteAudioObject(storedKey).catch(() => {});
      removeUpload(req.file?.filename);
      throw error;
    }
  }),
);

router.get(
  "/:id/stream",
  wrap(async (req, res) => {
    const audio = await prisma.audioFile.findUnique({ where: { id: req.params.id } });
    if (!audio) throw new HttpError(404, "Audio file not found");
    assertAreaAccess(req.user, audio.areaId);
    await streamAudio(res, audio, false);
  }),
);

router.get(
  "/:id/download",
  wrap(async (req, res) => {
    const audio = await prisma.audioFile.findUnique({ where: { id: req.params.id } });
    if (!audio) throw new HttpError(404, "Audio file not found");
    assertAreaAccess(req.user, audio.areaId);
    await streamAudio(res, audio, true);
  }),
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    if (!canDeleteAudio(req.user)) {
      throw new HttpError(403, "Only makers (or platform admins) can delete collection files");
    }
    const audio = await prisma.audioFile.findUnique({ where: { id: req.params.id } });
    if (!audio) throw new HttpError(404, "Audio file not found");
    assertAreaAccess(req.user, audio.areaId);
    const used = await prisma.announcement.count({ where: { audioFileId: audio.id } });
    if (used > 0) {
      throw new HttpError(409, "This file is used by an announcement and cannot be deleted");
    }
    await prisma.audioFile.delete({ where: { id: audio.id } });
    await deleteAudioObject(audio.s3Key);
    res.json({ ok: true });
  }),
);

export default router;
