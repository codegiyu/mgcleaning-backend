import "dotenv/config";

import { eq } from "drizzle-orm";
import { recordAudit } from "../audit/audit.js";
import { hashPassword } from "../auth/password.js";
import { passwordPolicyError } from "../auth/password-policy.js";
import { closeDb, getDb } from "../db/client.js";
import { adminSessions } from "../db/schema/adminSessions.js";
import { adminUsers } from "../db/schema/adminUsers.js";

/**
 * Operator recovery for a locked-out admin, run inside the API container. The new password
 * comes from the environment, not argv, so it never lands in shell history or `ps` output.
 * Every session for the account is revoked in the same transaction.
 */
async function main() {
  const email = process.env.ADMIN_RESET_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_RESET_PASSWORD;
  if (!email || !password) {
    throw new Error("Set ADMIN_RESET_EMAIL and ADMIN_RESET_PASSWORD before resetting an admin password.");
  }
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(`Reset password: ${policyError}`);

  const passwordHash = await hashPassword(password);
  const revokedSessions = await getDb().transaction(async (tx) => {
    const [user] = await tx
      .update(adminUsers)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(adminUsers.email, email))
      .returning({ id: adminUsers.id });
    if (!user) throw new Error(`No admin account exists for ${email}.`);
    const revoked = await tx.delete(adminSessions).where(eq(adminSessions.userId, user.id)).returning({ id: adminSessions.id });
    await recordAudit(tx, { actorId: null, ipHash: null, requestId: null }, {
      action: "auth.password_reset",
      entityType: "admin_user",
      entityId: user.id,
      metadata: { via: "cli", revokedSessions: revoked.length },
    });
    return revoked.length;
  });
  console.info(`Reset the password for ${email} and signed out ${revokedSessions} session(s). Remove ADMIN_RESET_PASSWORD from the environment now.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin password reset failed.");
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
