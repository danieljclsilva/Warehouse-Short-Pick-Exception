import { pgEnum, pgTable, text, timestamp, uuid, integer, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleEnum = pgEnum("user_role", ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "ADMIN"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "DISABLED", "ARCHIVED"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  displayName: text("display_name").notNull(),
  pinHash: text("pin_hash").notNull(),
  role: roleEnum("role").notNull().default("PICKER"),
  status: userStatusEnum("status").notNull().default("ACTIVE"),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [uniqueIndex("users_identifier_uq").on(table.identifier), index("users_status_idx").on(table.status)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
}, (table) => [uniqueIndex("sessions_token_hash_uq").on(table.tokenHash), index("sessions_user_active_idx").on(table.userId, table.revokedAt)]);

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxRegistrations: integer("max_registrations").notNull().default(1),
  registrationsUsed: integer("registrations_used").notNull().default(0),
  defaultRole: roleEnum("default_role").notNull().default("PICKER"),
  defaultPermissions: jsonb("default_permissions").$type<string[]>().notNull().default([]),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("invites_token_hash_uq").on(table.tokenHash),
  index("invites_expiry_idx").on(table.expiresAt),
  check("invites_registration_bounds_check", sql`${table.maxRegistrations} > 0 AND ${table.registrationsUsed} >= 0 AND ${table.registrationsUsed} <= ${table.maxRegistrations}`),
]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  targetUserId: uuid("target_user_id").references(() => users.id),
  action: text("action").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_log_target_created_idx").on(table.targetUserId, table.createdAt)]);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
