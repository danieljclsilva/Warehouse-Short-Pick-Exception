import { boolean, pgEnum, pgTable, text, timestamp, uuid, integer, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleEnum = pgEnum("user_role", ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "DISABLED", "ARCHIVED"]);
export const profilePhotoStatusEnum = pgEnum("profile_photo_status", ["NONE", "PENDING", "APPROVED", "REJECTED", "SUPERSEDED"]);
export const casePhaseEnum = pgEnum("case_phase", ["PICKING", "STAGED", "CLOSED"]);
export const physicalStateEnum = pgEnum("physical_state", ["WITH_PICKER", "SHORT_PICK_HOLD", "OTHER_KNOWN_LOCATION", "UNKNOWN"]);
export const caseSourceEnum = pgEnum("case_source", ["PICKER_REPORT", "TL_MANUAL", "ASSISTANT_MANUAL", "MANAGER_MANUAL", "ADMIN_MANUAL"]);
export const shortPickLineStateEnum = pgEnum("short_pick_line_state", ["OPEN", "CHECKING", "FOUND", "RETRIEVING", "RESOLVED", "CANCELLED"]);
export const checkTaskStatusEnum = pgEnum("check_task_status", ["AVAILABLE", "CLAIMED", "ASSIGNED", "COMPLETED"]);
export const checkCompletionCodeEnum = pgEnum("check_completion_code", ["FOUND", "FOUND_AT_ORIGINAL", "NOT_FOUND", "WRONG_LOCATION", "OTHER"]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "RESPONSIBILITY_CASE_ASSIGNED", "RESPONSIBILITY_CHECK_ASSIGNED", "RESPONSIBILITY_RETRIEVAL_ASSIGNED",
  "RESPONSIBILITY_NEW_LOCATION", "RESPONSIBILITY_CASE_REOPENED",
  "NEW_SHORT_PICK", "CHECK_CLAIMED", "NEW_LOCATION", "TROUBLESHOOTER_MESSAGE",
  "UNRESOLVED_OVER_THRESHOLD", "CASE_RESOLVED", "PROFILE_PHOTO_APPROVAL_REQUIRED",
]);
export const notificationPreferenceKeyEnum = pgEnum("notification_preference_key", [
  "NEW_SHORT_PICK", "CHECK_CLAIMED", "NEW_LOCATION", "TROUBLESHOOTER_MESSAGE",
  "UNRESOLVED_OVER_THRESHOLD", "CASE_RESOLVED",
]);
export const pushOutboxStatusEnum = pgEnum("push_outbox_status", ["QUEUED", "PROCESSING", "SENT", "RETRY", "FAILED", "DISABLED"]);

export const configurationVersions = pgTable("configuration_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull(),
  values: jsonb("values").$type<Record<string, unknown>>().notNull(),
  changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("configuration_versions_version_uq").on(table.version), index("configuration_versions_created_idx").on(table.createdAt)]);

export const configurationAudits = pgTable("configuration_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  previousVersionId: uuid("previous_version_id").references(() => configurationVersions.id),
  newVersionId: uuid("new_version_id").notNull().references(() => configurationVersions.id),
  changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  changedValues: jsonb("changed_values").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("configuration_audits_changed_idx").on(table.changedAt), index("configuration_audits_new_version_idx").on(table.newVersionId)]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  displayName: text("display_name").notNull(),
  pinHash: text("pin_hash"),
  passwordHash: text("password_hash"),
  role: roleEnum("role").notNull().default("PICKER"),
  status: userStatusEnum("status").notNull().default("ACTIVE"),
  profilePhotoStatus: profilePhotoStatusEnum("profile_photo_status").notNull().default("NONE"),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [uniqueIndex("users_identifier_uq").on(table.identifier), index("users_status_idx").on(table.status),
  check("users_credential_exactly_one_check", sql`(${table.pinHash} IS NULL) <> (${table.passwordHash} IS NULL)`)]);

export const profilePhotos = pgTable("profile_photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  revision: integer("revision").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull().default("image/jpeg"),
  byteSize: integer("byte_size").notNull(),
  status: profilePhotoStatusEnum("status").notNull().default("PENDING"),
  reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
  reviewReason: text("review_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("profile_photos_user_revision_uq").on(table.userId, table.revision),
  index("profile_photos_status_created_idx").on(table.status, table.createdAt),
  check("profile_photos_revision_positive_check", sql`${table.revision} > 0`),
  check("profile_photos_byte_size_positive_check", sql`${table.byteSize} > 0`),
]);

export const analyticsReports = pgTable("analytics_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  generatedByUserId: uuid("generated_by_user_id").notNull().references(() => users.id),
  objectKey: text("object_key").notNull().unique(),
  filename: text("filename").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  byteSize: integer("byte_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("analytics_reports_user_created_idx").on(table.generatedByUserId, table.createdAt)]);

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

export const orderCases = pgTable("order_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: text("order_number").notNull(),
  phase: casePhaseEnum("phase").notNull().default("PICKING"),
  physicalState: physicalStateEnum("physical_state").notNull().default("WITH_PICKER"),
  physicalLocation: text("physical_location"),
  pickingUserId: uuid("picking_user_id").references(() => users.id),
  currentCaseResponsibleUserId: uuid("current_case_responsible_user_id").references(() => users.id),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  source: caseSourceEnum("source").notNull().default("PICKER_REPORT"),
  manualReason: text("manual_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  stagedAt: timestamp("staged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  reopenedAt: timestamp("reopened_at", { withTimezone: true }),
  configurationVersionId: uuid("configuration_version_id").notNull().references(() => configurationVersions.id),
  version: integer("version").notNull().default(1),
}, (table) => [
  index("order_cases_order_created_idx").on(table.orderNumber, table.createdAt),
  index("order_cases_created_at_idx").on(table.createdAt),
  index("order_cases_phase_idx").on(table.phase),
  index("order_cases_configuration_version_idx").on(table.configurationVersionId),
  index("order_cases_responsible_user_idx").on(table.currentCaseResponsibleUserId),
  index("order_cases_picking_phase_idx").on(table.pickingUserId, table.phase),
  uniqueIndex("order_cases_one_open_per_order_uq").on(table.orderNumber).where(sql`${table.phase} <> 'CLOSED'`),
  check("order_cases_order_number_digits_check", sql`${table.orderNumber} ~ '^[0-9]+$'`),
  check("order_cases_version_positive_check", sql`${table.version} > 0`),
]);

export const shortPickLines = pgTable("short_pick_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => orderCases.id),
  originalLocation: text("original_location").notNull(),
  sku: text("sku").notNull(),
  missingQuantity: integer("missing_quantity").notNull(),
  reportedByUserId: uuid("reported_by_user_id").notNull().references(() => users.id),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  state: shortPickLineStateEnum("state").notNull().default("OPEN"),
  currentResponsibleUserId: uuid("current_responsible_user_id").references(() => users.id),
  discoveredLocation: text("discovered_location"),
  discoveredByUserId: uuid("discovered_by_user_id").references(() => users.id),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }),
  retrievalState: text("retrieval_state").notNull().default("NOT_REQUIRED"),
  retrievalResponsibleUserId: uuid("retrieval_responsible_user_id").references(() => users.id),
  retrievedByUserId: uuid("retrieved_by_user_id").references(() => users.id),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  replenishmentState: text("replenishment_state").notNull().default("NONE"),
  replenishmentNote: text("replenishment_note"),
  replenishmentActorUserId: uuid("replenishment_actor_user_id").references(() => users.id),
  replenishmentAt: timestamp("replenishment_at", { withTimezone: true }),
  replenishmentRetrieverUserId: uuid("replenishment_retriever_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionCode: text("resolution_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  index("short_pick_lines_case_idx").on(table.caseId, table.createdAt),
  index("short_pick_lines_location_idx").on(table.originalLocation),
  index("short_pick_lines_sku_idx").on(table.sku),
  index("short_pick_lines_retrieval_responsible_idx").on(table.retrievalResponsibleUserId),
  index("short_pick_lines_duplicate_idx").on(table.caseId, table.originalLocation, table.sku, table.state),
  index("short_pick_lines_reporter_reported_idx").on(table.reportedByUserId, table.reportedAt),
  check("short_pick_lines_location_normalized_check", sql`${table.originalLocation} = upper(btrim(${table.originalLocation})) AND length(${table.originalLocation}) > 0`),
  check("short_pick_lines_sku_normalized_check", sql`${table.sku} = upper(btrim(${table.sku})) AND length(${table.sku}) > 0`),
  check("short_pick_lines_quantity_positive_check", sql`${table.missingQuantity} > 0`),
  check("short_pick_lines_replenishment_state_check", sql`${table.replenishmentState} in ('NONE', 'WAITING', 'COMPLETED')`),
  check("short_pick_lines_version_positive_check", sql`${table.version} > 0`),
]);

export const checkTasks = pgTable("check_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  shortPickLineId: uuid("short_pick_line_id").notNull().references(() => shortPickLines.id),
  status: checkTaskStatusEnum("status").notNull().default("AVAILABLE"),
  claimedByUserId: uuid("claimed_by_user_id").references(() => users.id),
  assignedToUserId: uuid("assigned_to_user_id").references(() => users.id),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completionCode: checkCompletionCodeEnum("completion_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  index("check_tasks_status_created_idx").on(table.status, table.createdAt),
  index("check_tasks_line_created_idx").on(table.shortPickLineId, table.createdAt),
  index("check_tasks_assignee_status_idx").on(table.assignedToUserId, table.status),
  uniqueIndex("check_tasks_one_active_per_line_uq").on(table.shortPickLineId).where(sql`${table.status} <> 'COMPLETED'`),
  check("check_tasks_version_positive_check", sql`${table.version} > 0`),
]);

export const caseEvents = pgTable("case_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => orderCases.id),
  shortPickLineId: uuid("short_pick_line_id").references(() => shortPickLines.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("case_events_case_created_idx").on(table.caseId, table.createdAt), index("case_events_created_idx").on(table.createdAt)]);

export const caseMessages = pgTable("case_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => orderCases.id),
  shortPickLineId: uuid("short_pick_line_id").references(() => shortPickLines.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("case_messages_case_created_idx").on(table.caseId, table.createdAt),
  check("case_messages_text_length_check", sql`length(btrim(${table.message})) BETWEEN 1 AND 2000`)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipientUserId: uuid("recipient_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").notNull(),
  caseId: uuid("case_id").references(() => orderCases.id, { onDelete: "set null" }),
  shortPickLineId: uuid("short_pick_line_id").references(() => shortPickLines.id, { onDelete: "set null" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  pushAttemptedAt: timestamp("push_attempted_at", { withTimezone: true }),
}, (table) => [
  index("notifications_recipient_created_idx").on(table.recipientUserId, table.createdAt),
  index("notifications_recipient_unread_idx").on(table.recipientUserId, table.readAt),
  uniqueIndex("notifications_recipient_dedupe_uq").on(table.recipientUserId, table.dedupeKey).where(sql`${table.dedupeKey} IS NOT NULL`),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id").notNull().references(() => users.id),
  key: notificationPreferenceKeyEnum("key").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  thresholdMinutes: integer("threshold_minutes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("notification_preferences_user_key_uq").on(table.userId, table.key),
  check("notification_preferences_threshold_check", sql`${table.thresholdMinutes} IS NULL OR ${table.thresholdMinutes} BETWEEN 1 AND 1440`),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  expirationTime: timestamp("expiration_time", { withTimezone: true }),
  deviceLabel: text("device_label").notNull().default("Browser device"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("push_subscriptions_endpoint_uq").on(table.endpoint),
  index("push_subscriptions_user_active_idx").on(table.userId, table.disabledAt),
  check("push_subscriptions_endpoint_https_check", sql`${table.endpoint} LIKE 'https://%'`),
  check("push_subscriptions_device_label_length_check", sql`length(btrim(${table.deviceLabel})) BETWEEN 1 AND 100`),
]);

export const pushOutbox = pgTable("push_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  notificationId: uuid("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "cascade" }),
  status: pushOutboxStatusEnum("status").notNull().default("QUEUED"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("push_outbox_notification_subscription_uq").on(table.notificationId, table.subscriptionId),
  index("push_outbox_claim_idx").on(table.status, table.availableAt, table.leaseUntil),
  check("push_outbox_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
]);
