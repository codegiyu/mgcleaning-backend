import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { adminAuditEvents } from "../db/schema/adminAuditEvents.js";
import { env } from "../env.js";
import { resolveClientIp } from "../security/inquiry-abuse.js";

export const auditActions = [
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "inquiry.update",
  "post.create",
  "post.update",
  "post.publish",
  "post.unpublish",
  "post.archive",
  "media.upload",
  "media.update",
  "media.delete",
] as const;
export type AuditAction = (typeof auditActions)[number];

/** Who performed an action and from where. IPs are stored only as keyed hashes. */
export type AuditContext = {
  actorId: string | null;
  ipHash: string | null;
  requestId: string | null;
};

export type AuditEntry = {
  action: AuditAction;
  entityType: "admin_user" | "inquiry" | "blog_post" | "media_asset";
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

type DatabaseExecutor = Pick<ReturnType<typeof getDb>, "insert">;

export function hashAuditIp(ip: string) {
  if (!ip || ip === "unknown") return null;
  return createHmac("sha256", env.INQUIRY_SECURITY_SECRET).update(`audit:${ip}`).digest("hex");
}

export function auditContextFrom(context: Context, actorId: string | null): AuditContext {
  const requestId = context.get("requestId") as string | undefined;
  return { actorId, ipHash: hashAuditIp(resolveClientIp(context)), requestId: requestId ?? null };
}

/** Pass the transaction handle so the audit row commits or rolls back with the change it records. */
export async function recordAudit(executor: DatabaseExecutor, audit: AuditContext, entry: AuditEntry) {
  await executor.insert(adminAuditEvents).values({
    actorId: audit.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ipHash: audit.ipHash,
    requestId: audit.requestId,
  });
}

/** Names of the fields a patch touches, so audit metadata never carries their values. */
export function changedFields(patch: Record<string, unknown>) {
  return Object.keys(patch).filter((key) => patch[key] !== undefined).sort();
}
