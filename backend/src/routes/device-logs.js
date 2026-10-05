import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, parse } from "../lib/http.js";
import { pageMeta, readPage } from "../lib/pagination.js";
import { requireAuth, requireRoles, wrap } from "../middleware/auth.js";
import { sendCommand } from "../realtime/hub.js";
import { LOG_LEVELS } from "../realtime/logs.js";

const router = Router();
router.use(requireAuth, requireRoles("SUPERADMIN", "ADMIN"));

const EXPORT_LIMIT = 20_000;

function parseMoment(value, endOfDay, label) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`)
    : new Date(text);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is invalid`);
  return date;
}

function buildWhere(query) {
  const where = {};
  if (query.speakerId) where.speakerId = String(query.speakerId);
  const level = String(query.level || "").toUpperCase();
  if (LOG_LEVELS.includes(level)) where.level = { in: LOG_LEVELS.slice(LOG_LEVELS.indexOf(level)) };
  const logger = String(query.logger || "").trim();
  if (logger) where.logger = { startsWith: logger };
  const q = String(query.q || "").trim();
  if (q) where.message = { contains: q, mode: "insensitive" };
  const from = parseMoment(query.from, false, "From date");
  const to = parseMoment(query.to, true, "To date");
  if (from || to) where.loggedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  return where;
}

const speakerBrief = { select: { id: true, name: true, deviceId: true, area: { select: { id: true, name: true } } } };

router.get(
  "/",
  wrap(async (req, res) => {
    const where = buildWhere(req.query);
    const { page, pageSize, skip, take } = readPage(req.query, { defaultSize: 100, maxSize: 500 });
    const [total, logs] = await Promise.all([
      prisma.deviceLog.count({ where }),
      prisma.deviceLog.findMany({
        where,
        include: { speaker: speakerBrief },
        orderBy: [{ loggedAt: "desc" }, { receivedAt: "desc" }],
        skip,
        take,
      }),
    ]);
    res.json({ logs, meta: pageMeta({ page, pageSize, total }) });
  }),
);

router.get(
  "/export",
  wrap(async (req, res) => {
    const where = buildWhere(req.query);
    const logs = await prisma.deviceLog.findMany({
      where,
      include: { speaker: { select: { deviceId: true } } },
      orderBy: [{ loggedAt: "desc" }, { receivedAt: "desc" }],
      take: EXPORT_LIMIT,
    });
    const lines = logs
      .reverse()
      .map((row) => `${row.loggedAt.toISOString()} ${row.speaker.deviceId} ${row.level.padEnd(8)} ${row.logger}: ${row.message}`);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="speaker-logs-${stamp}.log"`);
    res.send(lines.join("\n") + "\n");
  }),
);

async function findSpeaker(id) {
  const speaker = await prisma.speaker.findUnique({ where: { id } });
  if (!speaker) throw new HttpError(404, "Speaker not found");
  return speaker;
}

const journalSchema = z.object({
  source: z.enum(["agent", "system", "kernel", "boot", "diagnostics"]).default("agent"),
  lines: z.coerce.number().int().min(10).max(5000).default(500),
  since: z.string().trim().max(40).optional(),
});

router.get(
  "/:speakerId/journal",
  wrap(async (req, res) => {
    const speaker = await findSpeaker(req.params.speakerId);
    const query = parse(journalSchema, req.query);
    const result = await sendCommand(speaker.id, { action: "journal", ...query }, 30_000);
    res.json({ text: result.data?.text ?? "", truncated: Boolean(result.data?.truncated), source: query.source });
  }),
);

const levelSchema = z.object({ level: z.enum(["DEBUG", "INFO", "WARNING"]) });

router.post(
  "/:speakerId/level",
  wrap(async (req, res) => {
    const speaker = await findSpeaker(req.params.speakerId);
    const { level } = parse(levelSchema, req.body);
    const result = await sendCommand(speaker.id, { action: "log_level", value: level });
    res.json({ ok: true, message: result.message, state: result.state });
  }),
);

export default router;
