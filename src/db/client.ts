import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

function createConnection(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  return { client, db: drizzle({ client, schema }) };
}

type DatabaseConnection = ReturnType<typeof createConnection>;
let connection: DatabaseConnection | undefined;

export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required before accessing PostgreSQL.");
  }

  connection ??= createConnection(databaseUrl);
  return connection.db;
}

export async function closeDb() {
  if (!connection) return;
  await connection.client.end();
  connection = undefined;
}
