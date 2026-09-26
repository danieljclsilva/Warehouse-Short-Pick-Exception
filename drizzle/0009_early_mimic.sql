CREATE TYPE "public"."push_outbox_status" AS ENUM('QUEUED', 'PROCESSING', 'SENT', 'RETRY', 'FAILED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "push_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" "push_outbox_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_outbox_attempts_nonnegative_check" CHECK ("push_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"expiration_time" timestamp with time zone,
	"device_label" text DEFAULT 'Browser device' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_https_check" CHECK ("push_subscriptions"."endpoint" LIKE 'https://%'),
	CONSTRAINT "push_subscriptions_device_label_length_check" CHECK (length(btrim("push_subscriptions"."device_label")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_outbox_notification_subscription_uq" ON "push_outbox" USING btree ("notification_id","subscription_id");--> statement-breakpoint
CREATE INDEX "push_outbox_claim_idx" ON "push_outbox" USING btree ("status","available_at","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_active_idx" ON "push_subscriptions" USING btree ("user_id","disabled_at");