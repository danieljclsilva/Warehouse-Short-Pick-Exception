ALTER TYPE "public"."case_source" ADD VALUE 'MANAGER_MANUAL' BEFORE 'ADMIN_MANUAL';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'MANAGER' BEFORE 'ADMIN';