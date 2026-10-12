import { bucket, defineRailway, github, postgres, preserve, project, ref, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "europe-west4-drams3a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgres202609271224UTC = volume("postgres-2026-09-27 12:24 UTC", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  const profilePhotosAndReports = bucket("profile-photos-and-reports", { region: "ams" });
  // EU backup bucket (ams). The old sjc backup buckets were deleted via dashboard
  // after byte-identical migration.
  const databaseBackupsEu = bucket("database-backups-eu", { region: "ams" });
  // Railway-managed PITR archive bucket (auto-named by `railway postgres pitr enable`,
  // ams). Must stay declared: whole-project IaC deletes undeclared live resources.
  // Never remove this stanza unless PITR is disabled via dashboard first.
  const pitrArchive = bucket("tidy-shelf-yyW1", { region: "ams" });
  const notificationsEmitter = service("notifications-emitter", {
    start: "npm run notifications:emit",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });
  const web = service("web", {
    source: github("danieljclsilva/Warehouse-Short-Pick-Exception", { checkSuites: true }),
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    preDeploy: "npm run db:migrate",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["shortpickexception.nl"],
    env: { APP_URL: preserve(), DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve(), STORAGE_ACCESS_KEY_ID: preserve(), STORAGE_BUCKET: preserve(), STORAGE_ENDPOINT: preserve(), STORAGE_FORCE_PATH_STYLE: preserve(), STORAGE_REGION: preserve(), STORAGE_SECRET_ACCESS_KEY: preserve() },
  });
  // Cron checks the current Amsterdam schedule, exits outside shift/warm-up,
  // and polls every 5s during the shift. Railway skips overlapping cron runs.
  // Whole-project IaC apply
  // deletes live resources this file omits (test env: Postgres-ltHj,
  // push-delivery, web-test) — NEVER apply without first running
  // `railway config pull` to import them, or scope IaC to production resources.
  const pushDelivery = service("push-delivery", {
    build: { builder: "DOCKERFILE", dockerfilePath: "push/Dockerfile" },
    start: "node build/push-worker.cjs",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });
  const databaseBackup = service("database-backup", {
    source: github("danieljclsilva/Warehouse-Short-Pick-Exception", { checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "backup/Dockerfile" },
    start: "sh /backup/run-backup.sh",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "15 2 * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      BACKUP_AGE_RECIPIENT: preserve(),
      S3_BUCKET: ref(databaseBackupsEu, "BUCKET"),
      S3_ENDPOINT_URL: ref(databaseBackupsEu, "ENDPOINT"),
      AWS_REGION: ref(databaseBackupsEu, "REGION"),
      AWS_ACCESS_KEY_ID: ref(databaseBackupsEu, "ACCESS_KEY_ID"),
      AWS_SECRET_ACCESS_KEY: ref(databaseBackupsEu, "SECRET_ACCESS_KEY"),
      S3_ADDRESSING_STYLE: "virtual",
    },
  });

  return project("warehouse-short-pick-exception", {
    resources: [notificationsEmitter, Postgres, web, pushDelivery, databaseBackup, postgres202609271224UTC, profilePhotosAndReports, databaseBackupsEu, pitrArchive],
  });
});
