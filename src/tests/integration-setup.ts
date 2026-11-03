import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { Redis } from "ioredis";

/**
 * Runs once before the integration suite: refuses any database whose name does not
 * contain "test" (the suite deletes everything), applies the migrations, and empties
 * every table so each run starts from the same state.
 */
export default async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error("Integration tests need DATABASE_URL and REDIS_URL.");
  const name = new URL(databaseUrl).pathname.slice(1);
  if (!/test/i.test(name)) {
    const message = `Refusing to run integration tests against "${name}": the database name must contain "test".`;
    // Printed as well as thrown: Vitest's reporter can mangle errors from global setup.
    console.error(message);
    throw new Error(message);
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
    await client.unsafe(
      "TRUNCATE contact_inquiries, email_outbox, admin_users, admin_sessions, admin_audit_events, blog_posts, gallery_items, media_assets, reviews, cache_revalidations, channel_clicks, site_settings RESTART IDENTITY CASCADE",
    );
  } finally {
    await client.end();
  }

  // Rate-limit counters from earlier local runs would turn the first requests into 429s.
  // Only counter keys are removed; BullMQ queue data is left alone.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    for (const pattern of ["inquiry:*", "mg:*", "events:*"]) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(...keys);
    }
  } finally {
    await redis.quit();
  }
}
