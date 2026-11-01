import "dotenv/config";

import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { passwordPolicyError } from "../auth/password-policy.js";
import { closeDb, getDb } from "../db/client.js";
import { adminUsers } from "../db/schema/adminUsers.js";

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before bootstrapping an admin.");
  }
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(`Initial admin password: ${policyError}`);
  const [existing] = await getDb().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  if (existing) {
    console.info(`Admin ${email} already exists; no changes were made.`);
    return;
  }
  // The first account is an owner: it can add staff and other owners from the dashboard.
  await getDb().insert(adminUsers).values({ email, role: "owner", passwordHash: await hashPassword(password) });
  console.info(`Created initial owner account for ${email}. Remove the bootstrap password from the environment now.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin bootstrap failed.");
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
