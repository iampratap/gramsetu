import { Router } from "express";
import { prisma } from "../db.js";
import { HttpError, canBroadcast } from "../lib/http.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  wrap(async (req, res) => {
    if (!canBroadcast(req.user)) throw new HttpError(403, "Only admins can view live broadcasts");
    const { page, pageSize, skip, take } = readPage(req.query, { defaultSize: 10 });
    const [total, broadcasts] = await Promise.all([
      prisma.broadcast.count(),
      prisma.broadcast.findMany({
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
