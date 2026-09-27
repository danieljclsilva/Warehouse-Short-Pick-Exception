import { bucket, defineRailway, github, postgres, preserve, project, ref, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "europe-west4-drams3a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgres202609271224UTC = volume("postgres-2026-09-27 12:24 UTC", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  // Legacy detached US volume (sfo, 471MB). Kept until EU backups verified, then delete via dashboard.
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const profilePhotosAndReports = bucket("profile-photos-and-reports", { region: "ams" });
  // Bucket regions are immutable after creation, so US buckets stay declared until
  // their objects are migrated and the new EU buckets are verified. Never remove
  // an old bucket from this file before its objects are copied and confirmed.
  const PostgresPITR = bucket("Postgres-PITR", { region: "sjc" });
  const databaseBackups = bucket("database-backups", { region: "sjc" });
  const databaseBackupsEu = bucket("database-backups-eu", { region: "ams" });
  const notificationsEmitter = service("notifications-emitter", {
    start: "npm run notifications:emit",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });
  const web = service("web", {
    source: github("danieljclsilva/Warehouse-Short-Pick-Exception", { checkSuites: false }),
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    preDeploy: "npm run db:migrate",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["shortpickexception.nl"],
    env: { APP_URL: preserve(), DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve(), STORAGE_ACCESS_KEY_ID: preserve(), STORAGE_BUCKET: preserve(), STORAGE_ENDPOINT: preserve(), STORAGE_FORCE_PATH_STYLE: preserve(), STORAGE_REGION: preserve(), STORAGE_SECRET_ACCESS_KEY: preserve() },
  });
  const pushDelivery = service("push-delivery", {
    start: "npm run push:deliver",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });
  const databaseBackup = service("database-backup", {
    source: github("danieljclsilva/Warehouse-Short-Pick-Exception", { checkSuites: false }),
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
    resources: [notificationsEmitter, Postgres, web, pushDelivery, databaseBackup, postgres202609271224UTC, postgresVolume, profilePhotosAndReports, PostgresPITR, databaseBackups, databaseBackupsEu],
  });
});
