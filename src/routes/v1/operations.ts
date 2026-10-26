import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditContextFrom, auditEntityTypes, changedFields, recordAudit, type AuditContext, type AuditEntityType } from "../../audit/audit.js";
import { getDb } from "../../db/client.js";
import { adminAuditEvents } from "../../db/schema/adminAuditEvents.js";
import { adminUsers } from "../../db/schema/adminUsers.js";
import { siteSettings } from "../../db/schema/siteSettings.js";
import { effectiveNotificationEmail, readSiteSettings, SITE_SETTINGS_ID } from "../../settings/site-settings.js";
import { forbiddenOrigin, pageResult, pageSchema, trustedOrigin, type PageQuery } from "./admin-shared.js";

type AdminVariables = { Variables: { admin: { id: string; email: string } } };

export type AuditEventView = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorEmail: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: Date;
};

export type AuditQuery = PageQuery & { entityType?: AuditEntityType; entityId?: string };

export type SettingsView = {
  inquiryNotificationEmail: string | null;
  /** What alerts actually go to right now, including the environment fallback. */
  effectiveNotificationEmail: string;
  defaultAuthorName: string | null;
  updatedAt: Date | null;
};

export type SettingsPatch = { inquiryNotificationEmail?: string | null; defaultAuthorName?: string | null };

export type OperationsRouterDependencies = {
  listAudit: (query: AuditQuery) => Promise<{ items: AuditEventView[]; total: number }>;
  getSettings: () => Promise<SettingsView>;
  updateSettings: (patch: SettingsPatch, audit: AuditContext) => Promise<SettingsView>;
};

const auditQuerySchema = pageSchema.extend({
  entityType: z.enum(auditEntityTypes).optional(),
  entityId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/).optional(),
});

const settingsPatchSchema = z
  .object({
    inquiryNotificationEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    defaultAuthorName: z.string().trim().min(2).max(120).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

function toSettingsView(row: Awaited<ReturnType<typeof readSiteSettings>>): SettingsView {
  return {
    inquiryNotificationEmail: row?.inquiryNotificationEmail ?? null,
    effectiveNotificationEmail: effectiveNotificationEmail(row),
    defaultAuthorName: row?.defaultAuthorName ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

function buildProductionDependencies(): OperationsRouterDependencies {
  return {
    async listAudit(query) {
      const conditions: SQL[] = [];
      if (query.entityType) conditions.push(eq(adminAuditEvents.entityType, query.entityType));
      if (query.entityId) conditions.push(eq(adminAuditEvents.entityId, query.entityId));
      const where = conditions.length ? and(...conditions) : undefined;
      const db = getDb();
      const [items, totals] = await Promise.all([
        db
          .select({
            id: adminAuditEvents.id,
            action: adminAuditEvents.action,
            entityType: adminAuditEvents.entityType,
            entityId: adminAuditEvents.entityId,
            actorEmail: adminUsers.email,
            metadata: adminAuditEvents.metadata,
            requestId: adminAuditEvents.requestId,
            createdAt: adminAuditEvents.createdAt,
          })
          .from(adminAuditEvents)
          .leftJoin(adminUsers, eq(adminUsers.id, adminAuditEvents.actorId))
          .where(where)
          .orderBy(desc(adminAuditEvents.createdAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(adminAuditEvents).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    async getSettings() {
      return toSettingsView(await readSiteSettings());
    },
    async updateSettings(patch, audit) {
      return getDb().transaction(async (tx) => {
        const values = { ...patch, updatedBy: audit.actorId, updatedAt: new Date() };
        const [row] = await tx
          .insert(siteSettings)
          .values({ id: SITE_SETTINGS_ID, ...values })
          .onConflictDoUpdate({ target: siteSettings.id, set: values })
          .returning();
        await recordAudit(tx, audit, {
          action: "settings.update",
          entityType: "site_settings",
          entityId: String(SITE_SETTINGS_ID),
          metadata: { fields: changedFields(patch) },
        });
        return toSettingsView(row ?? null);
      });
    },
  };
}

export function createOperationsRouter(dependencies: OperationsRouterDependencies = buildProductionDependencies()) {
  const router = new Hono<AdminVariables>();

  router.get("/audit", async (context) => {
    const parsed = auditQuerySchema.safeParse({
      page: context.req.query("page"),
      pageSize: context.req.query("pageSize"),
      entityType: context.req.query("entityType") || undefined,
      entityId: context.req.query("entityId") || undefined,
    });
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Invalid activity filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listAudit(parsed.data);
    return context.json({ success: true as const, message: "Activity loaded.", responseCode: 200, data: pageResult(result.items, result.total, parsed.data) });
  });

  router.get("/settings", async (context) => {
    const data = await dependencies.getSettings();
    return context.json({ success: true as const, message: "Settings loaded.", responseCode: 200, data });
  });

  router.patch("/settings", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = settingsPatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Please check the settings and try again.", responseCode: 400 }, 400);
    }
    const data = await dependencies.updateSettings(parsed.data, auditContextFrom(context, context.get("admin").id));
    return context.json({ success: true as const, message: "Settings saved.", responseCode: 200, data });
  });

  return router;
}
