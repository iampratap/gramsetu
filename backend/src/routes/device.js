import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, parse } from "../lib/http.js";
import { speakerFromHeaders } from "../lib/device-auth.js";
import { getAudioObject } from "../lib/s3.js";
import { wrap } from "../middleware/auth.js";
import { publishReports } from "../realtime/hub.js";

const router = Router();

const audioSelect = { id: true, title: true, sizeBytes: true };

function presentAudio(audio) {
  return { id: audio.id, title: audio.title, sizeBytes: audio.sizeBytes, url: `/api/device/audio/${audio.id}` };
}

async function touchSpeaker(speaker) {
  await prisma.speaker.update({
    where: { id: speaker.id },
    data: {
      lastSeenAt: new Date(),
      ...(speaker.status === "OFFLINE" ? { status: "ONLINE" } : {}),
    },
  });
}

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

router.get(
  "/sync",
  wrap(async (req, res) => {
    const speaker = await speakerFromHeaders(req);
    await touchSpeaker(speaker);

    // One day of slack on either side covers any timezone offset.
    const yesterday = isoDay(-1);
    // Timed and repeating announcements go to the speaker as schedules it plays on its own clock.
    const schedules = await prisma.announcement.findMany({
      where: {
        status: "APPROVED",
        isActive: true,
        repeat: { not: "NOW" },
        deliveries: { some: { speakerId: speaker.id, status: "SCHEDULED" } },
        OR: [{ endDate: null }, { endDate: { gte: yesterday } }],
        NOT: { repeat: "ONCE", startDate: { lt: yesterday } },
      },
      include: { audioFile: { select: audioSelect } },
      orderBy: { createdAt: "asc" },
    });

    if (schedules.length) {
      await prisma.announcementDelivery.updateMany({
        where: { speakerId: speaker.id, status: "SCHEDULED", sentAt: null, announcementId: { in: schedules.map((item) => item.id) } },
        data: { sentAt: new Date() },
      });
    }

    const deliveries = await prisma.announcementDelivery.findMany({
      where: {
        speakerId: speaker.id,
        status: { in: ["QUEUED", "SENT"] },
        announcement: { status: "APPROVED", repeat: "NOW", isActive: true },
      },
      include: { announcement: { include: { audioFile: { select: audioSelect } } } },
      orderBy: { createdAt: "asc" },
    });
    const queued = deliveries.filter((item) => item.status === "QUEUED").map((item) => item.id);
    if (queued.length) {
      await prisma.announcementDelivery.updateMany({
        where: { id: { in: queued }, status: "QUEUED" },
        data: { status: "SENT", sentAt: new Date() },
      });
    }

    res.json({
      speaker: { id: speaker.id, name: speaker.name, location: speaker.location, deviceId: speaker.deviceId },
      serverTime: new Date().toISOString(),
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        title: schedule.title,
        repeat: schedule.repeat,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        times: schedule.times,
        daysOfWeek: schedule.daysOfWeek,
        timezone: schedule.timezone,
        updatedAt: schedule.updatedAt,
        audio: presentAudio(schedule.audioFile),
      })),
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        announcementId: delivery.announcementId,
        title: delivery.announcement.title,
        playAt: null,
        audio: presentAudio(delivery.announcement.audioFile),
      })),
    });
  }),
);

const timestamp = z.string().datetime({ offset: true }).nullish();
const reportSchema = z.object({
  reports: z
    .array(
      z.object({
        localId: z.string().trim().min(1).max(64),
        source: z.enum(["SCHEDULE", "ANNOUNCEMENT", "LIVE_TEST", "BROADCAST"]),
        result: z.enum(["COMPLETED", "SKIPPED", "STOPPED", "FAILED"]),
        title: z.string().max(200).default(""),
        scheduleId: z.string().max(64).nullish(),
        deliveryId: z.string().max(64).nullish(),
        broadcastId: z.string().max(64).nullish(),
        audioFileId: z.string().max(64).nullish(),
        scheduledFor: timestamp,
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: z.number().int().nonnegative().nullish(),
        error: z.string().max(500).nullish(),
        playedOffline: z.boolean().optional(),
      }),
    )
    .max(500),
});

const toDate = (value) => (value ? new Date(value) : null);

router.post(
  "/reports",
  wrap(async (req, res) => {
    const speaker = await speakerFromHeaders(req);
    await touchSpeaker(speaker);
    const { reports } = parse(reportSchema, req.body);
    if (reports.length === 0) return res.json({ accepted: [] });

    const localIds = reports.map((item) => item.localId);
    const existing = await prisma.playLog.findMany({
      where: { speakerId: speaker.id, localId: { in: localIds } },
      select: { localId: true },
    });
    const known = new Set(existing.map((item) => item.localId));
    const fresh = reports.filter((item) => !known.has(item.localId));

    if (fresh.length) {
      await prisma.playLog.createMany({
        data: fresh.map((item) => ({
          speakerId: speaker.id,
          localId: item.localId,
          source: item.source,
          result: item.result,
          title: item.title || "Untitled",
          scheduleId: item.scheduleId || null,
          deliveryId: item.deliveryId || null,
          broadcastId: item.broadcastId || null,
          audioFileId: item.audioFileId || null,
          scheduledFor: toDate(item.scheduledFor),
          startedAt: toDate(item.startedAt),
          endedAt: toDate(item.endedAt),
          durationMs: item.durationMs ?? null,
          error: item.error || null,
          playedOffline: Boolean(item.playedOffline),
        })),
        skipDuplicates: true,
      });

      for (const item of fresh.filter((report) => report.deliveryId)) {
        const played = item.result === "COMPLETED";
        await prisma.announcementDelivery.updateMany({
          where: { id: item.deliveryId, speakerId: speaker.id, status: "SENT" },
          data: played ? { status: "ACKNOWLEDGED", ackAt: toDate(item.endedAt) || new Date() } : { status: "FAILED" },
        });
      }

      const saved = await prisma.playLog.findMany({
        where: { speakerId: speaker.id, localId: { in: fresh.map((item) => item.localId) } },
        include: { speaker: { select: { id: true, name: true, location: true, areaId: true } } },
      });
      publishReports(speaker.areaId, saved);
    }

    res.json({ accepted: localIds });
  }),
);

router.get(
  "/audio/:audioId",
  wrap(async (req, res) => {
    const speaker = await speakerFromHeaders(req);
    const audio = await prisma.audioFile.findUnique({ where: { id: req.params.audioId } });
    if (!audio || audio.areaId !== speaker.areaId) {
      throw new HttpError(404, "That audio file is not in this speaker's area");
    }
    const object = await getAudioObject(audio.s3Key);
    res.setHeader("Content-Type", audio.mimeType || object.contentType || "audio/wav");
    if (object.contentLength) res.setHeader("Content-Length", object.contentLength);
    object.body.pipe(res);
  }),
);

// Legacy polling flow for speakers that do not run the GramSetu agent.
router.get(
  "/poll",
  wrap(async (req, res) => {
    const speaker = await speakerFromHeaders(req);
    await touchSpeaker(speaker);
    const brief = { id: speaker.id, name: speaker.name, deviceId: speaker.deviceId };

    const delivery = await prisma.announcementDelivery.findFirst({
      where: {
        speakerId: speaker.id,
        status: "QUEUED",
        announcement: { status: "APPROVED", repeat: "NOW", isActive: true },
      },
      orderBy: { createdAt: "asc" },
      include: { announcement: { include: { audioFile: true } } },
    });
    if (!delivery) return res.json({ speaker: brief, delivery: null });

    const claimed = await prisma.announcementDelivery.updateMany({
      where: { id: delivery.id, status: "QUEUED" },
      data: { status: "SENT", sentAt: new Date() },
    });
    if (claimed.count === 0) return res.json({ speaker: brief, delivery: null });

    res.json({
      speaker: brief,
      delivery: {
        id: delivery.id,
        announcementId: delivery.announcementId,
        title: delivery.announcement.title,
        notes: delivery.announcement.notes,
        audioUrl: `/api/device/audio/${delivery.announcement.audioFileId}`,
      },
    });
  }),
);

router.post(
  "/ack",
  wrap(async (req, res) => {
    const speaker = await speakerFromHeaders(req);
    await touchSpeaker(speaker);
    const body = parse(z.object({ deliveryId: z.string().min(1, "deliveryId is required") }), req.body);
    const updated = await prisma.announcementDelivery.updateMany({
      where: { id: body.deliveryId, speakerId: speaker.id, status: "SENT" },
      data: { status: "ACKNOWLEDGED", ackAt: new Date() },
    });
    if (updated.count === 0) throw new HttpError(404, "No sent announcement matches that delivery");
    res.json({ ok: true });
  }),
);

export default router;
