import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, isGlobal, parse, publicUser } from "../lib/http.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, wrap } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const ROLE_SET = new Set(["ADMIN", "MAKER", "CHECKER"]);

const createSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "MAKER", "CHECKER"]),
  areaId: z.string().trim().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2, "Name is required").optional(),
  email: z.string().trim().email("Enter a valid email").optional(),
  password: z.string().min(8, "Password must be at least 8 characters").optional().or(z.literal("")),
  role: z.enum(["ADMIN", "MAKER", "CHECKER"]).optional(),
  areaId: z.string().trim().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

async function resolveArea(actor, role, areaId) {
  if (!ROLE_SET.has(role)) throw new HttpError(400, "Unknown role");
  if (!isGlobal(actor)) throw new HttpError(403, "You cannot manage users");

  if (role === "ADMIN") {
    if (actor.role !== "SUPERADMIN") {
      throw new HttpError(403, "Only a super admin can manage platform admins");
    }
    if (areaId) throw new HttpError(400, "Platform admins are not assigned to an area");
    return null;
  }

  if (!areaId) throw new HttpError(400, "Choose an area");
  const area = await prisma.area.findUnique({ where: { id: areaId } });
  if (!area || !area.isActive) throw new HttpError(400, "Choose an active area");
  return area.id;
}

function assertCanTouch(actor, target) {
  if (!isGlobal(actor)) throw new HttpError(403, "You cannot manage users");
  if (target.role === "SUPERADMIN") {
    throw new HttpError(403, "Super admin accounts are fixed");
  }
  if (target.role === "ADMIN" && actor.role !== "SUPERADMIN") {
    throw new HttpError(403, "Only a super admin can change platform admins");
  }
}

router.get(
  "/",
  wrap(async (req, res) => {
    if (!isGlobal(req.user)) {
      throw new HttpError(403, "You cannot view user management");
    }

    const where = {};
    const requestedRole = String(req.query.role || "").trim();

    if (req.user.role === "ADMIN") {
      if (requestedRole === "SUPERADMIN") throw new HttpError(403, "You cannot view super admins");
      where.role = requestedRole ? requestedRole : { not: "SUPERADMIN" };
      if (req.query.areaId) where.areaId = String(req.query.areaId);
    } else {
      if (requestedRole) where.role = requestedRole;
      if (req.query.areaId) where.areaId = String(req.query.areaId);
    }

    const q = String(req.query.q || "").trim();
    if (q) {
      where.AND = [
        {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        },
      ];
    }

    const { page, pageSize, skip, take } = readPage(req.query);
    const total = await prisma.user.count({ where });
    const users = await prisma.user.findMany({
      where,
      include: { area: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      skip,
      take,
    });
    res.json({ users: users.map(publicUser), meta: pageMeta({ page, pageSize, total }) });
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    const body = parse(createSchema, req.body);
    const areaId = await resolveArea(req.user, body.role, body.areaId || "");
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash,
        role: body.role,
        areaId,
        isActive: body.isActive ?? true,
      },
      include: { area: true },
    });
    res.status(201).json({ user: publicUser(user) });
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const body = parse(updateSchema, req.body);
    const existing = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { area: true },
    });
    if (!existing) throw new HttpError(404, "User not found");
    assertCanTouch(req.user, existing);

    if (existing.id === req.user.id && body.isActive === false) {
      throw new HttpError(400, "You cannot deactivate your own account");
    }

    const nextRole = body.role || existing.role;
    const nextAreaId = body.areaId !== undefined ? body.areaId : existing.areaId || "";
    if (body.role || body.areaId !== undefined) {
      if (existing.id === req.user.id && body.role && body.role !== existing.role) {
        throw new HttpError(400, "You cannot change your own role");
      }
      await resolveArea(req.user, nextRole, nextAreaId || "");
    }

    const data = {};
    if (body.name) data.name = body.name;
    if (body.email) data.email = body.email.toLowerCase();
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.role) data.role = body.role;
    if (body.areaId !== undefined || body.role) data.areaId = nextRole === "ADMIN" ? null : nextAreaId || null;
    if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);

    const user = await prisma.user.update({
      where: { id: existing.id },
      data,
      include: { area: true },
    });
    res.json({ user: publicUser(user) });
  }),
);

export default router;
