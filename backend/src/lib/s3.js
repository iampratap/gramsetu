import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const driver = (process.env.STORAGE_DRIVER || "s3").toLowerCase();
const bucket = process.env.S3_BUCKET || "gramsetu-audio";
const region = process.env.S3_REGION || "ap-south-1";
const localRoot = path.resolve(
  process.cwd(),
  process.env.S3_LOCAL_DIR || path.join(process.env.UPLOAD_DIR || "uploads", "s3"),
);

let client;
let ready;

function useLocal() {
  return driver === "local";
}

function getClient() {
  if (client) return client;
  const endpoint = process.env.S3_ENDPOINT || undefined;
  client = new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "gramsetu",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "gramsetu-secret",
    },
  });
  return client;
}

function localPath(key) {
  return path.join(localRoot, bucket, key);
}

export async function ensureBucket() {
  if (ready) return;
  if (useLocal()) {
    fs.mkdirSync(path.join(localRoot, bucket), { recursive: true });
    ready = true;
    return;
  }
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  ready = true;
}

export async function putAudioObject(key, body, contentType = "audio/wav") {
  await ensureBucket();
  if (useLocal()) {
    const filePath = localPath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (Buffer.isBuffer(body)) fs.writeFileSync(filePath, body);
    else if (typeof body === "string") fs.copyFileSync(body, filePath);
    else await pipeline(body, fs.createWriteStream(filePath));
    return { bucket, key };
  }
  const payload = typeof body === "string" ? fs.createReadStream(body) : body;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: payload,
      ContentType: contentType,
    }),
  );
  return { bucket, key };
}

export async function getAudioObject(key) {
  await ensureBucket();
  if (useLocal()) {
    const filePath = localPath(key);
    if (!fs.existsSync(filePath)) {
      const error = new Error("Audio object not found");
      error.status = 404;
      throw error;
    }
    return {
      body: fs.createReadStream(filePath),
      contentType: "audio/wav",
      contentLength: fs.statSync(filePath).size,
    };
  }
  let response;
  try {
    response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      const error = new Error("Audio object not found");
      error.status = 404;
      throw error;
    }
    throw err;
  }
  return {
    body: response.Body instanceof Readable ? response.Body : Readable.from(response.Body),
    contentType: response.ContentType || "audio/wav",
    contentLength: response.ContentLength,
  };
}

export async function deleteAudioObject(key) {
  if (!key) return;
  await ensureBucket();
  if (useLocal()) {
    fs.unlink(localPath(key), () => {});
    return;
  }
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // ignore missing objects
  }
}

export function storageInfo() {
  return {
    driver: useLocal() ? "local" : "s3",
    bucket,
    region,
    endpoint: process.env.S3_ENDPOINT || null,
  };
}

export { bucket as s3Bucket };
