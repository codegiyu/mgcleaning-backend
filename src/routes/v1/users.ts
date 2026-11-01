import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditContextFrom, recordAudit, type AuditContext } from "../../audit/audit.js";
import { hashPassword } from "../../auth/password.js";
import { generateTemporaryPassword } from "../../auth/temporary-password.js";
import { getDb } from "../../db/client.js";
import { isUniqueViolation } from "../../db/errors.js";
import { adminSessions } from "../../db/schema/adminSessions.js";
import { adminRoles, adminUsers, type AdminRole } from "../../db/schema/adminUsers.js";
import { forbiddenOrigin, requireOwner, trustedOrigin, uuidSchema } from "./admin-shared.js";

type AdminVariables = { Variables: { admin: { id: string; email: string; role: AdminRole } } };

export type AdminUserView = {
  id: string;
  email: string;
  role: AdminRole;
  mustChangePassword: boolean;
  deactivatedAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
};

export type UserChange = { role?: AdminRole; active?: boolean };

export type CreateUserResult = { kind: "created"; user: AdminUserView } | { kind: "duplicate" };
export type UpdateUserResult = { kind: "updated"; user: AdminUserView } | { kind: "not-found" } | { kind: "last-owner" };
export type ResetUserResult = { kind: "reset"; user: AdminUserView } | { kind: "not-found" };

export type UsersRouterDependencies = {
  listUsers: () => Promise<AdminUserView[]>;
  createUser: (input: { email: string; role: AdminRole; passwordHash: string }, audit: AuditContext) => Promise<CreateUserResult>;
  updateUser: (id: string, change: UserChange, audit: AuditContext) => Promise<UpdateUserResult>;
  resetPassword: (id: string, passwordHash: string, audit: AuditContext) => Promise<ResetUserResult>;
};

const createSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(adminRoles).default("staff") }).strict();
const updateSchema = z
  .object({ role: z.enum(adminRoles).optional(), active: z.boolean().optional() })
  .strict()
  .refine((value) => value.role !== undefined || value.active !== undefined);

const userColumns = {
  id: adminUsers.id,
  email: adminUsers.email,
  role: adminUsers.role,
  mustChangePassword: adminUsers.mustChangePassword,
  deactivatedAt: adminUsers.deactivatedAt,
  passwordChangedAt: adminUsers.passwordChangedAt,
  createdAt: adminUsers.createdAt,
};

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Active owners other than `exceptId`; at least one must always remain. */
async function otherActiveOwners(tx: Transaction, exceptId: string) {
  const [row] = await tx
    .select({ total: count() })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), isNull(adminUsers.deactivatedAt), ne(adminUsers.id, exceptId)));
  return Number(row?.total ?? 0);
}

function buildProductionDependencies(): UsersRouterDependencies {
  return {
    async listUsers() {
      const rows = await getDb().select(userColumns).from(adminUsers).orderBy(asc(adminUsers.createdAt));
      return rows.map((row) => ({ ...row, role: row.role as AdminRole }));
    },
    async createUser(input, audit) {
      try {
        return await getDb().transaction(async (tx): Promise<CreateUserResult> => {
          const [user] = await tx
            .insert(adminUsers)
            .values({ email: input.email, role: input.role, passwordHash: input.passwordHash, mustChangePassword: true })
            .returning(userColumns);
          if (!user) throw new Error("Admin user insert returned no row.");
          await recordAudit(tx, audit, { action: "user.create", entityType: "admin_user", entityId: user.id, metadata: { role: input.role } });
          return { kind: "created", user: { ...user, role: user.role as AdminRole } };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { kind: "duplicate" };
        throw error;
      }
    },
    async updateUser(id, change, audit) {
      return getDb().transaction(async (tx): Promise<UpdateUserResult> => {
        const [existing] = await tx.select(userColumns).from(adminUsers).where(eq(adminUsers.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        const losesOwner = existing.role === "owner" && !existing.deactivatedAt && (change.role === "staff" || change.active === false);
        if (losesOwner && (await otherActiveOwners(tx, id)) === 0) return { kind: "last-owner" };

        const values: Partial<typeof adminUsers.$inferInsert> = {};
        if (change.role && change.role !== existing.role) values.role = change.role;
        if (change.active === false && !existing.deactivatedAt) values.deactivatedAt = new Date();
        if (change.active === true && existing.deactivatedAt) values.deactivatedAt = null;
        const [user] = Object.keys(values).length
          ? await tx.update(adminUsers).set(values).where(eq(adminUsers.id, id)).returning(userColumns)
          : [existing];
        if (!user) return { kind: "not-found" };

        if (values.role) {
          await recordAudit(tx, audit, { action: "user.role_change", entityType: "admin_user", entityId: id, metadata: { roleFrom: existing.role, roleTo: values.role } });
        }
        if (values.deactivatedAt) {
          // A deactivated account is signed out everywhere at once.
          const revoked = await tx.delete(adminSessions).where(eq(adminSessions.userId, id)).returning({ id: adminSessions.id });
          await recordAudit(tx, audit, { action: "user.deactivate", entityType: "admin_user", entityId: id, metadata: { revokedSessions: revoked.length } });
        }
        if (values.deactivatedAt === null) {
          await recordAudit(tx, audit, { action: "user.reactivate", entityType: "admin_user", entityId: id });
        }
        return { kind: "updated", user: { ...user, role: user.role as AdminRole } };
      });
    },
    async resetPassword(id, passwordHash, audit) {
      return getDb().transaction(async (tx): Promise<ResetUserResult> => {
        const [user] = await tx
          .update(adminUsers)
          .set({ passwordHash, mustChangePassword: true, passwordChangedAt: new Date() })
          .where(eq(adminUsers.id, id))
          .returning(userColumns);
        if (!user) return { kind: "not-found" };
        const revoked = await tx.delete(adminSessions).where(eq(adminSessions.userId, id)).returning({ id: adminSessions.id });
        await recordAudit(tx, audit, { action: "user.password_reset", entityType: "admin_user", entityId: id, metadata: { revokedSessions: revoked.length } });
        return { kind: "reset", user: { ...user, role: user.role as AdminRole } };
      });
    },
  };
}

function refused(message: string, status: 400 | 404 | 409) {
  return { success: false as const, message, responseCode: status };
}

/**
 * Owner-only account management, mounted at `/v1/admin/users`. Temporary passwords are
 * generated here, returned once in the response for the owner to pass on, and must be
 * replaced at first sign-in. Owners change other accounts, never their own, so an active
 * owner always remains.
 */
export function createUsersRouter(dependencies: UsersRouterDependencies = buildProductionDependencies()) {
  const router = new Hono<AdminVariables>();
  router.use("*", requireOwner);

  router.get("/", async (context) => {
    const data = await dependencies.listUsers();
    return context.json({ success: true as const, message: "Accounts loaded.", responseCode: 200, data });
  });

  router.post("/", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json(refused("Enter a valid email address.", 400), 400);
    const temporaryPassword = generateTemporaryPassword();
    const result = await dependencies.createUser(
      { ...parsed.data, passwordHash: await hashPassword(temporaryPassword) },
      auditContextFrom(context, context.get("admin").id),
    );
    if (result.kind === "duplicate") return context.json(refused("An account with that email already exists.", 409), 409);
    return context.json({ success: true as const, message: "Account created.", responseCode: 201, data: { user: result.user, temporaryPassword } }, 201);
  });

  router.patch("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return context.json(refused("Account not found.", 404), 404);
    if (id.data === context.get("admin").id) return context.json(refused("Ask another owner to change your own role or access.", 400), 400);
    const parsed = updateSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json(refused("Choose a role or access change.", 400), 400);
    const result = await dependencies.updateUser(id.data, parsed.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind === "not-found") return context.json(refused("Account not found.", 404), 404);
    if (result.kind === "last-owner") return context.json(refused("At least one active owner must remain.", 409), 409);
    return context.json({ success: true as const, message: "Account updated.", responseCode: 200, data: result.user });
  });

  router.post("/:id/reset-password", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return context.json(refused("Account not found.", 404), 404);
    if (id.data === context.get("admin").id) return context.json(refused("Change your own password from Settings.", 400), 400);
    const temporaryPassword = generateTemporaryPassword();
    const result = await dependencies.resetPassword(id.data, await hashPassword(temporaryPassword), auditContextFrom(context, context.get("admin").id));
    if (result.kind === "not-found") return context.json(refused("Account not found.", 404), 404);
    return context.json({ success: true as const, message: "Password reset.", responseCode: 200, data: { user: result.user, temporaryPassword } });
  });

  return router;
}
