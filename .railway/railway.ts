import { bucket, defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 500 });
  const profilePhotosAndReports = bucket("profile-photos-and-reports", { region: "ams" });
  const PostgresPITR = bucket("Postgres-PITR", { region: "sjc" });
  const notificationsEmitter = service("notifications-emitter", {
    build: { builder: "RAILPACK" },
    start: "npm run notifications:emit",
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    replicas: { "sfo": 1 },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });
  const web = service("web", {
    build: { builder: "RAILPACK" },
    start: "npm start",
    preDeploy: "npm run db:migrate",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "sfo": 1 },
    env: {
      APP_URL: preserve(),
      DATABASE_URL: preserve(),
      PUSH_PRIVATE_KEY: preserve(),
      PUSH_PUBLIC_KEY: preserve(),
      PUSH_SUBJECT: preserve(),
      STORAGE_ACCESS_KEY_ID: preserve(),
      STORAGE_BUCKET: preserve(),
      STORAGE_ENDPOINT: preserve(),
      STORAGE_FORCE_PATH_STYLE: preserve(),
      STORAGE_REGION: preserve(),
      STORAGE_SECRET_ACCESS_KEY: preserve(),
    },
  });
  const pushDelivery = service("push-delivery", {
    build: { builder: "RAILPACK" },
    start: "npm run push:deliver",
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    replicas: { "sfo": 1 },
    env: { DATABASE_URL: preserve(), PUSH_PRIVATE_KEY: preserve(), PUSH_PUBLIC_KEY: preserve(), PUSH_SUBJECT: preserve() },
  });

  return project("warehouse-short-pick-exception", {
    resources: [notificationsEmitter, Postgres, web, pushDelivery, postgresVolume, profilePhotosAndReports, PostgresPITR],
  });
});
