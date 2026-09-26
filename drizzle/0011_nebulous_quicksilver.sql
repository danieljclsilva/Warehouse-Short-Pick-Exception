ALTER TABLE "configuration_audits" DROP CONSTRAINT "configuration_audits_changed_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "configuration_versions" DROP CONSTRAINT "configuration_versions_changed_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "configuration_audits" ADD CONSTRAINT "configuration_audits_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;