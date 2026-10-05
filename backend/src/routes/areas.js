import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, isGlobal, parse } from "../lib/http.js";
import { requireAuth, requireRoles, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const areaSchema = z.object({
  name: z.string().trim().min(2, "Area name is required"),
  code: z
    .string()
    .trim()
    .min(2, "Area code is required")
    .max(16, "Area code must be 16 characters or fewer")
    .regex(/^[a-zA-Z0-9-]+$/, "Area code can use letters, numbers, and hyphens"),
  district: z.string().trim().min(2, "District is required"),
  state: z.string().trim().min(2, "State is required"),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

router.get(
  "/",
  wrap(async (req, res) => {
    const where = isGlobal(req.user) ? {} : { id: req.user.areaId };
    const q = String(req.query.q || "").trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { district: { contains: q, mode: "insensitive" } },
      ];
    }
    const areas = await prisma.area.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        _count: { select: { speakers: true, users: true, audioFiles: true } },
      },
    });
    res.json({ areas });
  }),
);

router.post(
  "/",
  requireRoles("SUPERADMIN", "ADMIN"),
  wrap(async (req, res) => {
    const body = parse(areaSchema, req.body);
    const area = await prisma.area.create({
      data: {
        name: body.name,
        code: body.code.toUpperCase(),
        district: body.district,
        state: body.state,
        description: body.description || null,
        isActive: body.isActive ?? true,
      },
    });
    res.status(201).json({ area });
  }),
);

router.patch(
  "/:id",
  requireRoles("SUPERADMIN", "ADMIN"),
  wrap(async (req, res) => {
    const body = parse(areaSchema.partial(), req.body);
    const existing = await prisma.area.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Area not found");
    const area = await prisma.area.update({
      where: { id: existing.id },
      data: {
        ...("name" in body ? { name: body.name } : {}),
        ...("code" in body ? { code: body.code.toUpperCase() } : {}),
        ...("district" in body ? { district: body.district } : {}),
        ...("state" in body ? { state: body.state } : {}),
        ...("description" in body ? { description: body.description || null } : {}),
        ...("isActive" in body ? { isActive: body.isActive } : {}),
      },
    });
    res.json({ area });
  }),
);

export default router;
