import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, parse, publicUser } from "../lib/http.js";
import { requireAuth, signToken, wrap } from "../middleware/auth.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

router.post(
  "/login",
  wrap(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: { area: true },
    });
    if (!user || !user.isActive) {
      throw new HttpError(401, "Email or password is incorrect");
    }
    const match = await bcrypt.compare(body.password, user.passwordHash);
    if (!match) throw new HttpError(401, "Email or password is incorrect");
    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

export default router;
