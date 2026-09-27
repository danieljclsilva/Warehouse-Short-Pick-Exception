ALTER TABLE "users" ALTER COLUMN "pin_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credential_exactly_one_check" CHECK (("users"."pin_hash" IS NULL) <> ("users"."password_hash" IS NULL));