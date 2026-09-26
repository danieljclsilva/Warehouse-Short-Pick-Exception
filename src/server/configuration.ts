import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, configurationAudits, configurationVersions, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/case-errors";

export const RESOLUTION_CODES = ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"] as const;

export const CONFIGURATION_DEFAULTS = {
  MAX_SIMULTANEOUS_CHECKS_PER_CASE: 1,
  CLAIM_CHECKS_ENABLED: true,
  CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false,
  CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true,
  WARNING_THRESHOLD_MINUTES: 5,
  ATTENTION_THRESHOLD_MINUTES: 10,
  CRITICAL_THRESHOLD_MINUTES: 15,
  REQUIRE_STAGING_CONFIRMATION: true,
  INVITE_DEFAULT_EXPIRY_HOURS: 8,
  INVITE_DEFAULT_MAX_REGISTRATIONS: 1,
  LOGIN_MAX_FAILED_ATTEMPTS: 5,
  LOGIN_LOCKOUT_MINUTES: 15,
  SHORT_PICK_HOLD_LOCATION_NAME: "SHORT PICK / HOLD",
  ALLOWED_RESOLUTION_CODES: [...RESOLUTION_CODES],
  MANUAL_CASE_CREATION_ENABLED: true,
  ASSISTANT_CAN_MANAGE_CONFIGURATION: false,
  PUSH_ENABLED: true,
} as const;

export type ConfigurationValues = {
  MAX_SIMULTANEOUS_CHECKS_PER_CASE: number | null;
  CLAIM_CHECKS_ENABLED: boolean;
  CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: boolean;
  CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: boolean;
  WARNING_THRESHOLD_MINUTES: number;
  ATTENTION_THRESHOLD_MINUTES: number;
  CRITICAL_THRESHOLD_MINUTES: number;
  REQUIRE_STAGING_CONFIRMATION: boolean;
  INVITE_DEFAULT_EXPIRY_HOURS: number;
  INVITE_DEFAULT_MAX_REGISTRATIONS: number;
  LOGIN_MAX_FAILED_ATTEMPTS: number;
  LOGIN_LOCKOUT_MINUTES: number;
  SHORT_PICK_HOLD_LOCATION_NAME: string;
  ALLOWED_RESOLUTION_CODES: Array<(typeof RESOLUTION_CODES)[number]>;
  MANUAL_CASE_CREATION_ENABLED: boolean;
  ASSISTANT_CAN_MANAGE_CONFIGURATION: boolean;
  PUSH_ENABLED: boolean;
};

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const configurationShape = z.object({
  MAX_SIMULTANEOUS_CHECKS_PER_CASE: integer(1, 100).nullable(),
  CLAIM_CHECKS_ENABLED: z.boolean(),
  CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: z.boolean(),
  CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: z.boolean(),
  WARNING_THRESHOLD_MINUTES: integer(1, 1440),
  ATTENTION_THRESHOLD_MINUTES: integer(1, 1440),
  CRITICAL_THRESHOLD_MINUTES: integer(1, 1440),
  REQUIRE_STAGING_CONFIRMATION: z.boolean(),
  INVITE_DEFAULT_EXPIRY_HOURS: integer(1, 720),
  INVITE_DEFAULT_MAX_REGISTRATIONS: integer(1, 100),
  LOGIN_MAX_FAILED_ATTEMPTS: integer(1, 20),
  LOGIN_LOCKOUT_MINUTES: integer(1, 1440),
  SHORT_PICK_HOLD_LOCATION_NAME: z.string().trim().min(1).max(100),
  ALLOWED_RESOLUTION_CODES: z.array(z.enum(RESOLUTION_CODES)).min(1).max(RESOLUTION_CODES.length)
    .superRefine((values, ctx) => { if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Resolution codes must be unique" }); }),
  MANUAL_CASE_CREATION_ENABLED: z.boolean(),
  ASSISTANT_CAN_MANAGE_CONFIGURATION: z.boolean(),
  PUSH_ENABLED: z.boolean(),
}).strict();
const configurationSchema = configurationShape.superRefine((values, ctx) => {
  if (values.WARNING_THRESHOLD_MINUTES > values.ATTENTION_THRESHOLD_MINUTES) ctx.addIssue({ code: "custom", path: ["WARNING_THRESHOLD_MINUTES"], message: "Warning threshold cannot exceed attention threshold" });
  if (values.ATTENTION_THRESHOLD_MINUTES > values.CRITICAL_THRESHOLD_MINUTES) ctx.addIssue({ code: "custom", path: ["ATTENTION_THRESHOLD_MINUTES"], message: "Attention threshold cannot exceed critical threshold" });
});

export const configurationPatchSchema = z.object({
  values: configurationShape.partial(),
  expectedVersion: z.number().int().positive(),
}).strict();

export type ConfigurationPatch = z.infer<typeof configurationPatchSchema>;

export function normalizeConfigurationValues(values: unknown): ConfigurationValues {
  return configurationSchema.parse({ ...CONFIGURATION_DEFAULTS, ...(values && typeof values === "object" ? values : {}) });
}

export function assertConfigurationPermission(auth: AuthContext, current?: ConfigurationValues) {
  if (!hasAuthPermission(auth, "MANAGE_CONFIGURATION")) throw new CaseApiError("CASE_ACCESS_DENIED", "Configuration permission required", 403);
  if (auth.user.role === "ASSISTANT" && !current?.ASSISTANT_CAN_MANAGE_CONFIGURATION) {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Assistant configuration access is disabled", 403);
  }
  if (!["TEAM_LEADER", "ADMIN", "ASSISTANT"].includes(auth.user.role)) throw new CaseApiError("CASE_ACCESS_DENIED", "Only managers can manage configuration", 403);
}

export function canManageConfigurationForUser(user: { role: string; permissions: string[] }, current: ConfigurationValues) {
  const hasPermission = user.role === "ADMIN" || user.permissions.includes("MANAGE_CONFIGURATION");
  return hasPermission && (user.role !== "ASSISTANT" || current.ASSISTANT_CAN_MANAGE_CONFIGURATION);
}

type ConfigurationQueryExecutor = Pick<ReturnType<typeof getDb>, "select">;

export async function getConfigurationVersion(db: ConfigurationQueryExecutor, versionId: string) {
  const [row] = await db.select().from(configurationVersions).where(eq(configurationVersions.id, versionId)).limit(1);
  return row ? { ...row, values: normalizeConfigurationValues(row.values) } : null;
}

export async function getCurrentConfiguration(db: ConfigurationQueryExecutor = getDb()) {
  const [row] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
  if (!row) throw new Error("Configuration has not been initialized; run migrations");
  return { ...row, values: normalizeConfigurationValues(row.values) };
}

function changedValues(previous: ConfigurationValues, next: ConfigurationValues): Partial<ConfigurationValues> {
  const result: Partial<ConfigurationValues> = {};
  for (const key of Object.keys(CONFIGURATION_DEFAULTS) as Array<keyof ConfigurationValues>) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) result[key] = next[key] as never;
  }
  return result;
}

function publicActor(row: { id: string; displayName: string } | null) {
  return row ? { id: row.id, displayName: row.displayName } : null;
}

export async function getConfigurationForUser(auth: AuthContext) {
  const current = await getCurrentConfiguration();
  assertConfigurationPermission(auth, current.values);
  const history = await getDb().select({ version: configurationVersions.version, versionId: configurationVersions.id,
    values: configurationVersions.values, changedAt: configurationVersions.createdAt,
    changedById: users.id, changedByDisplayName: users.displayName,
    changedValues: configurationAudits.changedValues,
  }).from(configurationVersions).leftJoin(users, eq(configurationVersions.changedByUserId, users.id))
    .leftJoin(configurationAudits, eq(configurationAudits.newVersionId, configurationVersions.id))
    .orderBy(desc(configurationVersions.version)).limit(100);
  return {
    version: current.version,
    versionId: current.id,
    values: current.values,
    defaults: CONFIGURATION_DEFAULTS,
    changedAt: current.createdAt,
    changedBy: publicActor(current.changedByUserId ? (await getDb().select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, current.changedByUserId)).limit(1))[0] ?? null : null),
    history: history.map((row) => ({ version: row.version, versionId: row.versionId, values: normalizeConfigurationValues(row.values), changedAt: row.changedAt,
      changedBy: publicActor(row.changedById ? { id: row.changedById, displayName: row.changedByDisplayName! } : null), changedValues: row.changedValues ?? row.values })),
  };
}

export async function updateConfiguration(auth: AuthContext, input: ConfigurationPatch) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('short-pick-configuration'))`);
    const [currentRow] = await tx.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1).for("update");
    if (!currentRow) throw new Error("Configuration has not been initialized; run migrations");
    const current = { ...currentRow, values: normalizeConfigurationValues(currentRow.values) };
    assertConfigurationPermission(auth, current.values);
    if (auth.user.role === "ASSISTANT" && "ASSISTANT_CAN_MANAGE_CONFIGURATION" in input.values) {
      throw new CaseApiError("CASE_ACCESS_DENIED", "Assistants cannot change Assistant configuration access", 403);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new CaseApiError("CONFIGURATION_VERSION_CONFLICT", "Configuration changed since it was loaded", 409, { details: { currentVersion: current.version } });
    }
    const next = normalizeConfigurationValues({ ...current.values, ...input.values });
    const changes = changedValues(current.values, next);
    if (!Object.keys(changes).length) return { version: current.version, versionId: current.id, values: current.values, changedAt: current.createdAt, changedBy: null, changedValues: {} };
    const [created] = await tx.insert(configurationVersions).values({ version: current.version + 1, values: next, changedByUserId: auth.user.id }).returning();
    if (!created) throw new Error("Configuration version was not created");
    await tx.insert(configurationAudits).values({ previousVersionId: current.id, newVersionId: created.id, changedByUserId: auth.user.id, changedValues: changes });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CONFIGURATION_CHANGED", details: { previousVersion: current.version, newVersion: created.version, changedValues: changes } });
    return { version: created.version, versionId: created.id, values: next, changedAt: created.createdAt, changedBy: { id: auth.user.id, displayName: auth.user.displayName }, changedValues: changes };
  });
}

export function configurationDefaultsForDocs() {
  return CONFIGURATION_DEFAULTS;
}
