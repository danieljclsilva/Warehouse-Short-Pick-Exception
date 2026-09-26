import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

let client: ReturnType<typeof postgres> | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  if (!client) {
    client = postgres(url, { max: 10, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    database = drizzle(client, { schema });
  }
  return database!;
}

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  if (!client) {
    client = postgres(url, { max: 10, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    database = drizzle(client, { schema });
  }
  return client!;
}

export async function closeDb() {
  if (client) await client.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}
