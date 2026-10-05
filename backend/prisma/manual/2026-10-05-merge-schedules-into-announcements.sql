-- Folds Schedule/ScheduleSpeaker into Announcement/AnnouncementDelivery.
-- Run once against the old schema, before deploying the merged code:
--   sudo docker compose exec -T db psql -U gramsetu -d gramsetu -v ON_ERROR_STOP=1 < backend/prisma/manual/2026-10-05-merge-schedules-into-announcements.sql

-- New enum values must be committed before they can be used.
ALTER TYPE "ScheduleRepeat" ADD VALUE IF NOT EXISTS 'NOW' BEFORE 'ONCE';
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED' AFTER 'QUEUED';

BEGIN;

ALTER TABLE "Announcement"
  ADD COLUMN "repeat" "ScheduleRepeat" NOT NULL DEFAULT 'NOW',
  ADD COLUMN "startDate" TEXT,
  ADD COLUMN "endDate" TEXT,
  ADD COLUMN "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- "Play after" announcements become one-time announcements (scheduledAt is stored as UTC).
UPDATE "Announcement"
SET "repeat" = 'ONCE',
    "startDate" = to_char(("scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
    "times" = ARRAY[to_char(("scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')]
WHERE "scheduledAt" IS NOT NULL;

UPDATE "AnnouncementDelivery" d
SET status = 'SCHEDULED'
FROM "Announcement" a
WHERE d."announcementId" = a.id AND a."repeat" = 'ONCE' AND d.status IN ('QUEUED', 'SENT');

-- Schedules keep their ids, so play reports that point at them still match.
INSERT INTO "Announcement" (
  id, "areaId", "audioFileId", title, notes, status, "createdById", "reviewedById", "reviewNote", "reviewedAt",
  "createdAt", "updatedAt", "repeat", "startDate", "endDate", times, "daysOfWeek", timezone, "isActive"
)
SELECT
  id, "areaId", "audioFileId", title, NULL, 'APPROVED', "createdById", NULL,
  'Approved automatically when schedules were merged into announcements.', now(),
  "createdAt", "updatedAt", "repeat", "startDate", "endDate", times, "daysOfWeek", timezone, "isActive"
FROM "Schedule";

INSERT INTO "AnnouncementDelivery" (id, "announcementId", "speakerId", status, "createdAt")
SELECT 'mig' || substr(md5(ss."scheduleId" || ss."speakerId"), 1, 22), ss."scheduleId", ss."speakerId", 'SCHEDULED', now()
FROM "ScheduleSpeaker" ss;

DROP TABLE "ScheduleSpeaker";
DROP TABLE "Schedule";
ALTER TABLE "Announcement" DROP COLUMN "scheduledAt";

COMMIT;
