import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { ensureBucket, putAudioObject, s3Bucket } from "../src/lib/s3.js";

const prisma = new PrismaClient();

function writeTone(filePath, freq) {
  const sampleRate = 22050;
  const seconds = 1.4;
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const fade = Math.min(1, i / 300) * Math.min(1, (samples - i) / 1200);
    const tone = Math.sin(2 * Math.PI * freq * t) * 0.22 * fade;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tone)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function normalizeWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-c:a", "pcm_s16le", outputPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "ffmpeg failed"));
    });
  });
}

async function main() {
  await ensureBucket();
  const password = async (plain) => bcrypt.hash(plain, 10);
  const [superHash, adminHash, makerHash, checkerHash] = await Promise.all([
    password("Super@123"),
    password("Admin@123"),
    password("Maker@123"),
    password("Check@123"),
  ]);

  const rampur = await prisma.area.upsert({
    where: { code: "RAMPUR" },
    update: { name: "Rampur", district: "Sitapur", state: "Uttar Pradesh", isActive: true },
    create: {
      name: "Rampur",
      code: "RAMPUR",
      district: "Sitapur",
      state: "Uttar Pradesh",
      description: "Gram panchayat along the canal road.",
    },
  });

  const devgarh = await prisma.area.upsert({
    where: { code: "DEVGARH" },
    update: { name: "Devgarh", district: "Alwar", state: "Rajasthan", isActive: true },
    create: {
      name: "Devgarh",
      code: "DEVGARH",
      district: "Alwar",
      state: "Rajasthan",
      description: "Hill village with a weekly haat.",
    },
  });

  const users = [
    ["Super Admin", "superadmin@gramsetu.local", superHash, "SUPERADMIN", null],
    ["Platform Admin", "admin@gramsetu.local", adminHash, "ADMIN", null],
    ["Rampur Maker", "rampur.maker@gramsetu.local", makerHash, "MAKER", rampur.id],
    ["Rampur Checker", "rampur.checker@gramsetu.local", checkerHash, "CHECKER", rampur.id],
    ["Devgarh Maker", "devgarh.maker@gramsetu.local", makerHash, "MAKER", devgarh.id],
    ["Devgarh Checker", "devgarh.checker@gramsetu.local", checkerHash, "CHECKER", devgarh.id],
  ];

  const savedUsers = {};
  for (const [name, email, passwordHash, role, areaId] of users) {
    savedUsers[email] = await prisma.user.upsert({
      where: { email },
      update: { name, passwordHash, role, areaId, isActive: true },
      create: { name, email, passwordHash, role, areaId },
    });
  }

  await prisma.user.deleteMany({
    where: { email: { in: ["rampur.admin@gramsetu.local", "devgarh.admin@gramsetu.local"] } },
  });

  const speakerSeed = [
    ["spk-rampur-panchayat", "rampur-panchayat-demo-key", "Panchayat Bhawan", "Main chowk", rampur.id, "ONLINE"],
    ["spk-rampur-school", "rampur-school-demo-key", "Primary School", "School ground", rampur.id, "OFFLINE"],
    ["spk-rampur-bus", "rampur-bus-demo-key", "Bus Stand", "Bus stand shelter", rampur.id, "OFFLINE"],
    ["spk-devgarh-haat", "devgarh-haat-demo-key", "Haat Bazaar", "Weekly market", devgarh.id, "OFFLINE"],
    ["spk-devgarh-health", "devgarh-health-demo-key", "Health Centre", "Sub-centre courtyard", devgarh.id, "MAINTENANCE"],
  ];

  const speakers = {};
  for (const [deviceId, deviceKey, name, location, areaId, status] of speakerSeed) {
    speakers[deviceId] = await prisma.speaker.upsert({
      where: { deviceId },
      update: { deviceKey, name, location, areaId, status, isActive: true },
      create: { deviceId, deviceKey, name, location, areaId, status, isActive: true },
    });
  }

  await prisma.speaker.update({
    where: { deviceId: "spk-rampur-panchayat" },
    data: { lastSeenAt: new Date() },
  });

  async function ensureAudio(area, title, freq, uploaderEmail) {
    const existing = await prisma.audioFile.findFirst({ where: { areaId: area.id, title } });
    if (existing) return existing;

    const rawPath = path.join(os.tmpdir(), `seed-raw-${area.code}-${Date.now()}.wav`);
    const normPath = path.join(os.tmpdir(), `seed-norm-${area.code}-${Date.now()}.wav`);
    writeTone(rawPath, freq);
    await normalizeWav(rawPath, normPath);
    const s3Key = `areas/${area.code.toLowerCase()}/seed-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.wav`;
    const sizeBytes = fs.statSync(normPath).size;
    await putAudioObject(s3Key, normPath, "audio/wav");
    fs.unlinkSync(rawPath);
    fs.unlinkSync(normPath);

    return prisma.audioFile.create({
      data: {
        areaId: area.id,
        title,
        originalName: `${title}.wav`,
        s3Key,
        s3Bucket,
        mimeType: "audio/wav",
        sizeBytes,
        sampleRate: 16000,
        bitDepth: 16,
        channels: 1,
        uploadedById: savedUsers[uploaderEmail].id,
      },
    });
  }

  const water = await ensureAudio(rampur, "Boil drinking water notice", 523, "rampur.maker@gramsetu.local");
  const meeting = await ensureAudio(rampur, "Friday village meeting", 392, "rampur.maker@gramsetu.local");
  await ensureAudio(devgarh, "Cattle camp announcement", 330, "devgarh.maker@gramsetu.local");

  async function ensureAnnouncement(title, data, targets) {
    const existing = await prisma.announcement.findFirst({ where: { areaId: data.areaId, title } });
    if (existing) return existing;
    return prisma.announcement.create({
      data: {
        title,
        ...data,
        deliveries: { create: targets },
      },
    });
  }

  await ensureAnnouncement(
    "Drinking water advisory",
    {
      areaId: rampur.id,
      audioFileId: water.id,
      notes: "Play at the panchayat speaker after the morning school bell.",
      status: "APPROVED",
      createdById: savedUsers["rampur.maker@gramsetu.local"].id,
      reviewedById: savedUsers["rampur.checker@gramsetu.local"].id,
      reviewNote: "Audio is clear. Approved for the panchayat speaker.",
      reviewedAt: new Date(Date.now() - 1000 * 60 * 60 * 5),
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6),
    },
    [
      {
        speakerId: speakers["spk-rampur-panchayat"].id,
        status: "ACKNOWLEDGED",
        sentAt: new Date(Date.now() - 1000 * 60 * 60 * 4),
        ackAt: new Date(Date.now() - 1000 * 60 * 60 * 4 + 15000),
      },
    ],
  );

  await ensureAnnouncement(
    "Friday gram sabha reminder",
    {
      areaId: rampur.id,
      audioFileId: meeting.id,
      notes: "Remind households about the 4 pm meeting.",
      status: "PENDING",
      createdById: savedUsers["rampur.maker@gramsetu.local"].id,
    },
    [
      { speakerId: speakers["spk-rampur-school"].id, status: "HOLD" },
      { speakerId: speakers["spk-rampur-bus"].id, status: "HOLD" },
    ],
  );

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
