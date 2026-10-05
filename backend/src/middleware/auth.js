import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";

export function readToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (typeof req.query.access_token === "string" && req.query.access_token) {
    return req.query.access_token;
  }
  return null;
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, areaId: user.areaId },
    process.env.JWT_SECRET,
    { expiresIn: "12h" },
  );
}

export async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next(new HttpError(401, "Sign in required"));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { area: true },
    });
    if (!user || !user.isActive) {
      return next(new HttpError(401, "This account is not active"));
    }
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, "Session expired. Sign in again."));
  }
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, "You do not have access to this action"));
    }
    next();
  };
}

export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
