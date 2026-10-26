import { and, desc, eq, gt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditContextFrom, recordAudit, type AuditContext } from "../../audit/audit.js";
import { allowAttempt, clearAttempts } from "../../auth/login-rate-limit.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../../auth/password-policy.js";
import { getDb } from "../../db/client.js";
import { adminSessions } from "../../db/schema/adminSessions.js";
import { adminUsers } from "../../db/schema/adminUsers.js";
import { forbiddenOrigin, trustedOrigin, uuidSchema } from "./admin-shared.js";

export type SessionActor = { id: string; email: string; sessionId: string };
type AccountVariables = { Variables: { admin: SessionActor } };

export type SessionSummary = {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
};

export type ChangePasswordResult =
  | { kind: "changed"; revokedSessions: number }
  | { kind: "invalid-current" }
  | { kind: "reused" }
  | { kind: "rate-limited" };

export type AccountRouterDependencies = {
  /** Verifies the current password, stores the new hash, and signs out every other session. */
  changePassword: (
    input: { userId: string; keepSessionId: string; currentPassword: string; newPassword: string },
    audit: AuditContext,
  ) => Promise<ChangePasswordResult>;
  listSessions: (userId: string) => Promise<SessionSummary[]>;
  /** Scoped to the owner, so one admin cannot revoke another admin's session by ID. */
  revokeSession: (userId: string, sessionId: string, audit: AuditContext) => Promise<boolean>;
  revokeOtherSessions: (userId: string, keepSessionId: string, audit: AuditContext) => Promise<number>;
};

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

function buildProductionDependencies(): AccountRouterDependencies {
  return {
    async changePassword({ userId, keepSessionId, currentPassword, newPassword }, audit) {
      if (!(await allowAttempt("admin-password-change", userId))) return { kind: "rate-limited" };
      const [user] = await getDb()
        .select({ passwordHash: adminUsers.passwordHash })
        .from(adminUsers)
        .where(eq(adminUsers.id, userId))
        .limit(1);
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return { kind: "invalid-current" };
      if (await verifyPassword(newPassword, user.passwordHash)) return { kind: "reused" };
      const passwordHash = await hashPassword(newPassword);

      const result = await getDb().transaction(async (tx): Promise<ChangePasswordResult> => {
        // Compare-and-set on the old hash: a concurrent change (or CLI reset) wins and this one is refused.
        const updated = await tx
          .update(adminUsers)
          .set({ passwordHash, passwordChangedAt: new Date() })
          .where(and(eq(adminUsers.id, userId), eq(adminUsers.passwordHash, user.passwordHash)))
          .returning({ id: adminUsers.id });
        if (!updated.length) return { kind: "invalid-current" };
        const revoked = await tx
          .delete(adminSessions)
          .where(and(eq(adminSessions.userId, userId), ne(adminSessions.id, keepSessionId)))
          .returning({ id: adminSessions.id });
        await recordAudit(tx, audit, {
          action: "auth.password_change",
          entityType: "admin_user",
          entityId: userId,
          metadata: { revokedSessions: revoked.length },
        });
        return { kind: "changed", revokedSessions: revoked.length };
      });
      if (result.kind === "changed") await clearAttempts("admin-password-change", userId);
      return result;
    },
    async listSessions(userId) {
      return getDb()
        .select({
          id: adminSessions.id,
          createdAt: adminSessions.createdAt,
          lastUsedAt: adminSessions.lastUsedAt,
          expiresAt: adminSessions.expiresAt,
          userAgent: adminSessions.userAgent,
        })
        .from(adminSessions)
        .where(and(eq(adminSessions.userId, userId), gt(adminSessions.expiresAt, new Date())))
        .orderBy(desc(adminSessions.lastUsedAt))
        .limit(50);
    },
    async revokeSession(userId, sessionId, audit) {
      return getDb().transaction(async (tx) => {
        const revoked = await tx
          .delete(adminSessions)
          .where(and(eq(adminSessions.id, sessionId), eq(adminSessions.userId, userId)))
          .returning({ id: adminSessions.id });
        if (!revoked.length) return false;
        await recordAudit(tx, audit, { action: "auth.session_revoke", entityType: "admin_user", entityId: userId, metadata: { scope: "one" } });
        return true;
      });
    },
    async revokeOtherSessions(userId, keepSessionId, audit) {
      return getDb().transaction(async (tx) => {
        const revoked = await tx
          .delete(adminSessions)
          .where(and(eq(adminSessions.userId, userId), ne(adminSessions.id, keepSessionId)))
          .returning({ id: adminSessions.id });
        if (revoked.length) {
          await recordAudit(tx, audit, {
            action: "auth.session_revoke",
            entityType: "admin_user",
            entityId: userId,
            metadata: { scope: "others", revokedSessions: revoked.length },
          });
        }
        return revoked.length;
      });
    },
  };
}

export function createAccountRouter(dependencies: AccountRouterDependencies = buildProductionDependencies()) {
  const router = new Hono<AccountVariables>();

  router.post("/password", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = changePasswordSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        { success: false as const, message: `Use a new password between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`, responseCode: 400 },
        400,
      );
    }
    const admin = context.get("admin");
    const result = await dependencies.changePassword(
      { userId: admin.id, keepSessionId: admin.sessionId, ...parsed.data },
      auditContextFrom(context, admin.id),
    );
    if (result.kind === "rate-limited") {
      return context.json({ success: false as const, message: "Too many attempts. Try again in 15 minutes.", responseCode: 429 }, 429);
    }
    if (result.kind === "invalid-current") {
      return context.json({ success: false as const, message: "Your current password is incorrect.", responseCode: 400 }, 400);
    }
    if (result.kind === "reused") {
      return context.json({ success: false as const, message: "Choose a password you are not already using.", responseCode: 400 }, 400);
    }
    return context.json({
      success: true as const,
      message: "Password changed. Other devices have been signed out.",
      responseCode: 200,
      data: { revokedSessions: result.revokedSessions },
    });
  });

  router.get("/sessions", async (context) => {
    const admin = context.get("admin");
    const sessions = await dependencies.listSessions(admin.id);
    return context.json({
      success: true as const,
      message: "Sessions loaded.",
      responseCode: 200,
      data: sessions.map((session) => ({ ...session, current: session.id === admin.sessionId })),
    });
  });

  router.post("/sessions/revoke-others", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const admin = context.get("admin");
    const revokedSessions = await dependencies.revokeOtherSessions(admin.id, admin.sessionId, auditContextFrom(context, admin.id));
    return context.json({ success: true as const, message: "Other sessions signed out.", responseCode: 200, data: { revokedSessions } });
  });

  router.delete("/sessions/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = context.req.param("id");
    const admin = context.get("admin");
    if (!uuidSchema.safeParse(id).success) {
      return context.json({ success: false as const, message: "Session not found.", responseCode: 404 }, 404);
    }
    if (id === admin.sessionId) {
      return context.json({ success: false as const, message: "Use Sign out to end this session.", responseCode: 400 }, 400);
    }
    const revoked = await dependencies.revokeSession(admin.id, id, auditContextFrom(context, admin.id));
    if (!revoked) return context.json({ success: false as const, message: "Session not found.", responseCode: 404 }, 404);
    return context.json({ success: true as const, message: "Session signed out.", responseCode: 200, data: { revoked: true as const } });
  });

  return router;
}
