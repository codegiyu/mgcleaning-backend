import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { getDb } from "../db/client.js";
import { adminPasswordResets } from "../db/schema/adminPasswordResets.js";
import { adminSessions } from "../db/schema/adminSessions.js";
import { adminUsers } from "../db/schema/adminUsers.js";
import { emailOutbox, type NewEmailOutbox } from "../db/schema/emailOutbox.js";
import type { EmailAction } from "../emails/alert-actions.js";
import { hashPassword } from "./password.js";

export const PASSWORD_RESET_MINUTES = 30;
export const PASSWORD_RESET_KIND = "password_reset";

export function digestResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newResetToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: digestResetToken(token) };
}

/**
 * The token travels in the URL fragment, which browsers never send to a server or in a
 * Referer header, so it stays out of access logs; the reset page reads it in the browser.
 */
export function passwordResetLink(origin: string, token: string) {
  return `${origin}/admin/reset-password#token=${token}`;
}

export function passwordResetEmail(link: string): Pick<NewEmailOutbox, "subject" | "title" | "message" | "actions"> {
  const actions: EmailAction[] = [{ label: "Choose a new password", href: link }];
  return {
    subject: "Reset your dashboard password",
    title: "Reset your password",
    message: [
      "We received a request to reset the password for your M&G Cleaning Services dashboard account.",
      `The link works once and expires in ${PASSWORD_RESET_MINUTES} minutes. Resetting your password signs out every device.`,
      "If you didn't ask for this, you can ignore this email: your password stays the same.",
    ].join("\n\n"),
    actions,
  };
}

/**
 * Creates a reset link for an active account and its email in one transaction, cancelling
 * any earlier unused links. Returns the outbox row to queue, or null when the email has no
 * active account (the caller answers the same either way).
 */
export async function issuePasswordReset(email: string, origin: string, audit: AuditContext, now = new Date()): Promise<{ outboxId: string } | null> {
  const [user] = await getDb()
    .select({ id: adminUsers.id, email: adminUsers.email })
    .from(adminUsers)
    .where(and(eq(adminUsers.email, email.trim().toLowerCase()), isNull(adminUsers.deactivatedAt)))
    .limit(1);
  if (!user) return null;
  const { token, tokenHash } = newResetToken();
  return getDb().transaction(async (tx) => {
    await tx
      .update(adminPasswordResets)
      .set({ usedAt: now })
      .where(and(eq(adminPasswordResets.userId, user.id), isNull(adminPasswordResets.usedAt)));
    await tx.insert(adminPasswordResets).values({ userId: user.id, tokenHash, expiresAt: new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60_000) });
    const [outbox] = await tx
      .insert(emailOutbox)
      .values({ adminUserId: user.id, kind: PASSWORD_RESET_KIND, to: user.email, ...passwordResetEmail(passwordResetLink(origin, token)) })
      .returning({ id: emailOutbox.id });
    // The actor may be signed out, so the account is the entity and the actor stays as given.
    await recordAudit(tx, audit, { action: "auth.password_reset_request", entityType: "admin_user", entityId: user.id });
    return { outboxId: outbox!.id }; // The insert returns its row.
  });
}

export type ConfirmResetResult = { kind: "reset"; revokedSessions: number } | { kind: "invalid" };

/**
 * Uses a reset link: sets the new password, marks the link used, cancels the account's
 * other links, and signs out every session. Expired, used, or unknown links, and links for
 * deactivated accounts, are all refused the same way.
 */
export async function confirmPasswordReset(token: string, newPassword: string, audit: AuditContext, now = new Date()): Promise<ConfirmResetResult> {
  const passwordHash = await hashPassword(newPassword);
  return getDb().transaction(async (tx): Promise<ConfirmResetResult> => {
    // Claiming the link and checking it in one statement means two uses at once cannot both succeed.
    const [claimed] = await tx
      .update(adminPasswordResets)
      .set({ usedAt: now })
      .where(and(eq(adminPasswordResets.tokenHash, digestResetToken(token)), isNull(adminPasswordResets.usedAt), gt(adminPasswordResets.expiresAt, now)))
      .returning({ userId: adminPasswordResets.userId });
    if (!claimed) return { kind: "invalid" };
    const updated = await tx
      .update(adminUsers)
      .set({ passwordHash, passwordChangedAt: now, mustChangePassword: false })
      .where(and(eq(adminUsers.id, claimed.userId), isNull(adminUsers.deactivatedAt)))
      .returning({ id: adminUsers.id });
    if (!updated.length) return { kind: "invalid" };
    await tx.update(adminPasswordResets).set({ usedAt: now }).where(and(eq(adminPasswordResets.userId, claimed.userId), isNull(adminPasswordResets.usedAt)));
    const revoked = await tx.delete(adminSessions).where(eq(adminSessions.userId, claimed.userId)).returning({ id: adminSessions.id });
    await recordAudit(tx, { ...audit, actorId: claimed.userId }, {
      action: "auth.password_reset",
      entityType: "admin_user",
      entityId: claimed.userId,
      metadata: { method: "email_link", revokedSessions: revoked.length },
    });
    return { kind: "reset", revokedSessions: revoked.length };
  });
}
