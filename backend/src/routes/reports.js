import { Router } from "express";
import { prisma } from "../db.js";
import { HttpError, isGlobal } from "../lib/http.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const SOURCES = new Set(["SCHEDULE", "ANNOUNCEMENT", "LIVE_TEST", "BROADCAST"]);
const RESULTS = new Set(["COMPLETED", "SKIPPED", "STOPPED", "FAILED"]);

router.get(
  "/",
  wrap(async (req, res) => {
    const where = {};
    if (!isGlobal(req.user)) where.speaker = { areaId: req.user.areaId };
    else if (req.query.areaId) where.speaker = { areaId: String(req.query.areaId) };
    if (req.query.speakerId) where.speakerId = String(req.query.speakerId);
    if (req.query.scheduleId) where.scheduleId = String(req.query.scheduleId);
    const source = String(req.query.source || "");
    if (SOURCES.has(source)) where.source = source;
    const result = String(req.query.result || "");
    if (RESULTS.has(result)) where.result = result;
    if (req.query.offline === "true") where.playedOffline = true;

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (from || to) {
      where.startedAt = {};
      if (from) {
        const start = new Date(`${from}T00:00:00.000`);
        if (Number.isNaN(start.getTime())) throw new HttpError(400, "From date is invalid");
        where.startedAt.gte = start;
      }
      if (to) {
        const end = new Date(`${to}T23:59:59.999`);
        if (Number.isNaN(end.getTime())) throw new HttpError(400, "To date is invalid");
        where.startedAt.lte = end;
      }
    }

    const { page, pageSize, skip, take } = readPage(req.query, { defaultSize: 20 });
    const [total, reports] = await Promise.all([
      prisma.playLog.count({ where }),
      prisma.playLog.findMany({
        where,
        include: {
          speaker: {
            select: { id: true, name: true, location: true, area: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ startedAt: "desc" }, { receivedAt: "desc" }],
        skip,
        take,
      }),
    ]);
    res.json({ reports, meta: pageMeta({ page, pageSize, total }) });
  }),
);

export default router;
