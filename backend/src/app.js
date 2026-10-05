import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import areaRoutes from "./routes/areas.js";
import userRoutes from "./routes/users.js";
import speakerRoutes from "./routes/speakers.js";
import audioRoutes from "./routes/audio.js";
import announcementRoutes from "./routes/announcements.js";
import deviceRoutes from "./routes/device.js";
import reportRoutes from "./routes/reports.js";
import deviceLogRoutes from "./routes/device-logs.js";
import broadcastRoutes from "./routes/broadcasts.js";
import { HttpError } from "./lib/http.js";

export function createApp() {
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "gramsetu-api" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/areas", areaRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/speakers", speakerRoutes);
  app.use("/api/audio", audioRoutes);
  app.use("/api/announcements", announcementRoutes);
  app.use("/api/device", deviceRoutes);
  app.use("/api/reports", reportRoutes);
  app.use("/api/device-logs", deviceLogRoutes);
  app.use("/api/broadcasts", broadcastRoutes);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError || /audio file/i.test(err.message || "")) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "Audio file must be 25 MB or smaller" : err.message;
      return res.status(400).json({ error: message });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "That value is already in use" });
    }
    const status = err instanceof HttpError ? err.status : err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? "Something went wrong" : err.message;
    res.status(status).json({ error: message || "Request failed" });
  });

  return app;
}
