import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import multer from "multer";
import { deleteAudioObject, putAudioObject } from "./s3.js";
import { HttpError } from "./http.js";

const tempDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || "uploads", "tmp");
fs.mkdirSync(tempDir, { recursive: true });

const allowed = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "audio/x-m4a",
  "video/webm",
  "application/octet-stream",
]);

export const audioUpload = multer({
  storage: multer.diskStorage({
    destination: tempDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".bin";
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowed.has(file.mimetype) || file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Upload an audio file (mp3, wav, ogg, m4a, or aac)"));
  },
});

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new HttpError(500, "ffmpeg is not installed on the server"));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new HttpError(400, `Could not convert that audio file. ${stderr.split("\n").slice(-3).join(" ").trim()}`));
    });
  });
}

function removeTemp(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

export function removeUpload(filename) {
  if (!filename) return;
  removeTemp(path.join(tempDir, filename));
}

/**
 * Convert any uploaded audio to 16 kHz / 16-bit / mono WAV, store in S3, return metadata.
 */
export async function ingestNormalizedAudio({ file, areaCode }) {
  if (!file?.path) throw new HttpError(400, "Choose an audio file");
  const outputName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.wav`;
  const outputPath = path.join(os.tmpdir(), `gramsetu-${outputName}`);
  const s3Key = `areas/${String(areaCode || "general").toLowerCase()}/${outputName}`;

  try {
    await runFfmpeg(file.path, outputPath);
    const sizeBytes = fs.statSync(outputPath).size;
    await putAudioObject(s3Key, outputPath, "audio/wav");
    return {
      s3Key,
      originalName: file.originalname,
      mimeType: "audio/wav",
      sizeBytes,
      sampleRate: 16000,
      bitDepth: 16,
      channels: 1,
    };
  } catch (error) {
    await deleteAudioObject(s3Key).catch(() => {});
    throw error;
  } finally {
    removeTemp(file.path);
    removeTemp(outputPath);
  }
}

export { tempDir as uploadDir };
