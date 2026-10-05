import { Router } from "express";
import { prisma } from "../db.js";
import { areaWhere, effectiveSpeakerStatus, userBrief } from "../lib/http.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  wrap(async (req, res) => {
    const scope = areaWhere(req.user);
    const announcementWhere = scope.areaId ? { areaId: scope.areaId } : {};

    const [areas, speakers, audioFiles, grouped, recent] = await Promise.all([
      prisma.area.count({
        where: scope.areaId ? { id: scope.areaId, isActive: true } : { isActive: true },
      }),
      prisma.speaker.findMany({
        where: { ...scope, isActive: true },
        select: { status: true, lastSeenAt: true, isActive: true },
      }),
      prisma.audioFile.count({ where: scope }),
      prisma.announcement.groupBy({
        by: ["status"],
        where: announcementWhere,
        _count: { _all: true },
      }),
      prisma.announcement.findMany({
        where: announcementWhere,
        orderBy: { createdAt: "desc" },
        take: 6,
        include: {
          area: { select: { id: true, name: true, code: true } },
          audioFile: { select: { id: true, title: true } },
          createdBy: userBrief,
          deliveries: { select: { id: true, status: true } },
        },
      }),
    ]);

    const announcements = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const row of grouped) announcements[row.status] = row._count._all;

    const online = speakers.filter(
      (speaker) => effectiveSpeakerStatus(speaker) === "ONLINE",
    ).length;

    res.json({
      areas,
      speakers: speakers.length,
      speakersOnline: online,
      audioFiles,
      announcements,
      recent,
    });
  }),
);

export default router;
