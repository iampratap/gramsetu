import { prisma } from "../db.js";
import { HttpError } from "./http.js";

export async function authenticateDevice(deviceId, deviceKey) {
  if (!deviceId || !deviceKey) {
    throw new HttpError(401, "Speaker credentials are required");
  }
  const speaker = await prisma.speaker.findUnique({ where: { deviceId: String(deviceId) } });
  if (!speaker || !speaker.isActive || speaker.deviceKey !== String(deviceKey)) {
    throw new HttpError(401, "Speaker credentials were rejected");
  }
  if (speaker.status === "MAINTENANCE") {
    throw new HttpError(423, "Speaker is in maintenance");
  }
  return speaker;
}

export function speakerFromHeaders(req) {
  return authenticateDevice(req.header("x-device-id"), req.header("x-device-key"));
}
