import "dotenv/config";

import { eq } from "drizzle-orm";
import { parseBootstrapEmails } from "../auth/bootstrap-emails.js";
import { hashPassword } from "../auth/password.js";
import { passwordPolicyError } from "../auth/password-policy.js";
import { closeDb, getDb } from "../db/client.js";
import { adminUsers } from "../db/schema/adminUsers.js";

async function main() {
  const emails = parseBootstrapEmails(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!emails.length || !password) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL (one address, or several separated by commas) and BOOTSTRAP_ADMIN_PASSWORD before bootstrapping admins.");
  }
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(`Initial admin password: ${policyError}`);
  // One password is shared by every new account, so with several of them each person must
  // choose their own at first sign-in. A single account keeps its password as set.
  const mustChangePassword = emails.length > 1;
  let created = 0;
  for (const email of emails) {
    const [existing] = await getDb().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
    if (existing) {
      console.info(`Admin ${email} already exists; no changes were made.`);
      continue;
    }
    // Initial accounts are owners: they can add staff and other owners from the dashboard.
    await getDb().insert(adminUsers).values({ email, role: "owner", passwordHash: await hashPassword(password), mustChangePassword });
    created += 1;
    console.info(`Created owner account for ${email}.`);
  }
  if (created) console.info("Remove the bootstrap password from the environment now.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin bootstrap failed.");
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
