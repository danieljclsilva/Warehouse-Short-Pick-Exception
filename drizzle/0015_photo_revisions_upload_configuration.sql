ALTER TYPE "public"."profile_photo_status" ADD VALUE 'SUPERSEDED';--> statement-breakpoint
ALTER TABLE "profile_photos" DROP CONSTRAINT "profile_photos_user_id_unique";--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "revision" integer;--> statement-breakpoint
UPDATE "profile_photos" SET "revision" = 1 WHERE "revision" IS NULL;--> statement-breakpoint
ALTER TABLE "profile_photos" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_photos_user_revision_uq" ON "profile_photos" USING btree ("user_id","revision");--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_revision_positive_check" CHECK ("profile_photos"."revision" > 0);--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_byte_size_positive_check" CHECK ("profile_photos"."byte_size" > 0);
