import { isWithinPushWorkerHours, workingHoursFromConfiguration } from "@/domain/working-hours";
import type { ConfigurationValues } from "@/server/configuration";

/** TEST lifecycle requires a persistent replica; delivery still enforces hours. */
export function shouldRunPushWorker(values: ConfigurationValues, now: Date, railwayEnvironmentName?: string) {
  if (railwayEnvironmentName === "test") return true;
  return values.PUSH_ENABLED && isWithinPushWorkerHours(now, workingHoursFromConfiguration(values));
}
