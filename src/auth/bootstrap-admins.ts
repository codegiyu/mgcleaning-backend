import { getDb } from "../db/client.js";
import { adminUsers } from "../db/schema/adminUsers.js";
import { parseBootstrapEmails } from "./bootstrap-emails.js";
import { hashPassword } from "./password.js";
import { passwordPolicyError } from "./password-policy.js";

export type BootstrapResult = { created: string[]; existing: string[] };

/**
 * Creates an owner account for each bootstrap email that has none yet. Idempotent: an
 * existing account (active or deactivated) is never changed, so its password stays as its
 * owner set it, and running this on every start is safe. With several emails each new
 * account shares the one password, so each person must choose their own at first sign-in.
 * Throws on a malformed email list or a password that breaks the policy.
 */
export async function bootstrapAdmins(rawEmails: string | undefined, password: string | undefined): Promise<BootstrapResult> {
  const emails = parseBootstrapEmails(rawEmails);
  if (!emails.length || !password) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL (one address, or several separated by commas) and BOOTSTRAP_ADMIN_PASSWORD before bootstrapping admins.");
  }
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(`Initial admin password: ${policyError}`);

  const passwordHash = await hashPassword(password);
  const mustChangePassword = emails.length > 1;
  // ON CONFLICT DO NOTHING: two instances starting together cannot create or overwrite twice.
  const inserted = await getDb()
    .insert(adminUsers)
    .values(emails.map((email) => ({ email, role: "owner", passwordHash, mustChangePassword })))
    .onConflictDoNothing({ target: adminUsers.email })
    .returning({ email: adminUsers.email });
  const created = inserted.map((row) => row.email);
  return { created, existing: emails.filter((email) => !created.includes(email)) };
}
