import { Router } from "express";
import { prisma } from "../db.js";
import { isGlobal } from "../lib/http.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  wrap(async (req, res) => {
    const where = isGlobal(req.user) ? {} : { areaIds: { has: req.user.areaId || "" } };
    const { page, pageSize, skip, take } = readPage(req.query, { defaultSize: 10 });
    const [total, broadcasts] = await Promise.all([
      prisma.broadcast.count({ where }),
      prisma.broadcast.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true, role: true } } },
        orderBy: { startedAt: "desc" },
        skip,
        take,
      }),
    ]);
    res.json({ broadcasts, meta: pageMeta({ page, pageSize, total }) });
  }),
);

export default router;
