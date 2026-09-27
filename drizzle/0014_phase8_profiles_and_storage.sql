CREATE TYPE "public"."profile_photo_status" AS ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'PROFILE_PHOTO_APPROVAL_REQUIRED';--> statement-breakpoint
CREATE TABLE "analytics_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generated_by_user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_reports_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "profile_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"byte_size" integer NOT NULL,
	"status" "profile_photo_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by_user_id" uuid,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "profile_photos_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_photo_status" "profile_photo_status" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_reports" ADD CONSTRAINT "analytics_reports_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_reports_user_created_idx" ON "analytics_reports" USING btree ("generated_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "profile_photos_status_created_idx" ON "profile_photos" USING btree ("status","created_at");