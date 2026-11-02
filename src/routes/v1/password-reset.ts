import { Hono } from "hono";
import { z } from "zod";
import { auditContextFrom, type AuditContext } from "../../audit/audit.js";
import { allowPasswordResetConfirm, allowPasswordResetRequest } from "../../auth/login-rate-limit.js";
import { confirmPasswordReset, issuePasswordReset, PASSWORD_RESET_MINUTES, type ConfirmResetResult } from "../../auth/password-reset.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../../auth/password-policy.js";
import { env, primaryFrontendOrigin } from "../../env.js";
import { getRequestLogger } from "../../request-context.js";
import { enqueueEmail } from "../../queue/email.queue.js";
import { forbiddenOrigin, trustedOrigin } from "./admin-shared.js";

export type PasswordResetDependencies = {
  allowRequest: (email: string, clientKey: string) => Promise<boolean>;
  allowConfirm: (clientKey: string) => Promise<boolean>;
  /** Returns the outbox row to queue, or null when the email has no active account. */
  issue: (email: string, audit: AuditContext) => Promise<{ outboxId: string } | null>;
  confirm: (token: string, newPassword: string, audit: AuditContext) => Promise<ConfirmResetResult>;
  enqueue: (outboxId: string) => Promise<unknown>;
};

/** Same wording whether or not the email has an account, so the form cannot reveal who is an admin. */
export const RESET_REQUESTED_MESSAGE = `If that email belongs to a dashboard account, we've sent it a link to reset the password. The link works for ${PASSWORD_RESET_MINUTES} minutes.`;

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict();
const confirmSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

const productionDependencies: PasswordResetDependencies = {
  allowRequest: allowPasswordResetRequest,
  allowConfirm: allowPasswordResetConfirm,
  issue: (email, audit) => issuePasswordReset(email, primaryFrontendOrigin(env), audit),
  confirm: (token, newPassword, audit) => confirmPasswordReset(token, newPassword, audit),
  enqueue: (outboxId) => enqueueEmail({ outboxId }),
};

/** Signed-out password reset: ask for a link by email, then use it to choose a new password. */
export function createPasswordResetRouter(dependencies: PasswordResetDependencies = productionDependencies) {
  const router = new Hono();

  router.post("/request", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = requestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ success: false as const, message: "Enter a valid email address.", responseCode: 400 }, 400);
    const audit = auditContextFrom(context, null);
    try {
      if (!(await dependencies.allowRequest(parsed.data.email, audit.ipHash ?? "unknown"))) {
        return context.json({ success: false as const, message: "Too many reset requests. Try again in an hour.", responseCode: 429 }, 429);
      }
      const issued = await dependencies.issue(parsed.data.email, audit);
      // The outbox row is committed; if queueing fails, the worker's pending sweep sends it.
      if (issued) await dependencies.enqueue(issued.outboxId).catch((error: unknown) => getRequestLogger(context).warn({ err: error }, "password reset email not queued"));
      return context.json({ success: true as const, message: RESET_REQUESTED_MESSAGE, responseCode: 200 });
    } catch (error) {
      getRequestLogger(context).error({ err: error }, "password reset request failed");
      return context.json({ success: false as const, message: "Password reset is temporarily unavailable.", responseCode: 503 }, 503);
    }
  });

  router.post("/confirm", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const body = await context.req.json().catch(() => null);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      const badToken = !z.object({ token: confirmSchema.shape.token }).safeParse(body).success;
      return context.json(
        badToken
          ? { success: false as const, message: "This reset link is invalid or has expired. Ask for a new one.", responseCode: 400 }
          : { success: false as const, message: `Use a new password between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`, responseCode: 400 },
        400,
      );
    }
    const audit = auditContextFrom(context, null);
    try {
      if (!(await dependencies.allowConfirm(audit.ipHash ?? "unknown"))) {
        return context.json({ success: false as const, message: "Too many attempts. Try again in 15 minutes.", responseCode: 429 }, 429);
      }
      const result = await dependencies.confirm(parsed.data.token, parsed.data.newPassword, audit);
      if (result.kind === "invalid") {
        return context.json({ success: false as const, message: "This reset link is invalid or has expired. Ask for a new one.", responseCode: 400 }, 400);
      }
      return context.json({ success: true as const, message: "Password reset. Sign in with your new password.", responseCode: 200 });
    } catch (error) {
      getRequestLogger(context).error({ err: error }, "password reset failed");
      return context.json({ success: false as const, message: "Password reset is temporarily unavailable.", responseCode: 503 }, 503);
    }
  });

  return router;
}
