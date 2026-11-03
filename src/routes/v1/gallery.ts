import { and, asc, eq, like, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditContextFrom, recordAudit, type AuditContext } from "../../audit/audit.js";
import { GALLERY_TAG, notifyRevalidationQueued, queueRevalidation, revalidationForGalleryChange } from "../../cache/revalidation.js";
import { getDb } from "../../db/client.js";
import { isUniqueViolation } from "../../db/errors.js";
import { blogPosts } from "../../db/schema/blogPosts.js";
import { galleryItems, galleryItemStatuses, type GalleryItemStatus, type GalleryItemType } from "../../db/schema/galleryItems.js";
import { mediaAssets } from "../../db/schema/mediaAssets.js";
import {
  deleteConflicts,
  expectedUpdatedAtSchema,
  GALLERY_ITEM_LIMIT,
  galleryItemInputSchema,
  galleryItemPatchSchema,
  galleryReorderSchema,
  planGalleryWrite,
  reorderMatches,
  toPublicGalleryItem,
  type GalleryItemInput,
  type GalleryItemPatch,
  type GalleryItemView,
  type GalleryWritePlan,
  type PublicGalleryItem,
} from "../../gallery/policy.js";
import { mediaKindOf } from "../../media/policy.js";
import { forbiddenOrigin, trustedOrigin, uuidSchema } from "./admin-shared.js";

type AdminVariables = { Variables: { admin: { id: string; email: string } } };

type PlanRefusal = Exclude<GalleryWritePlan, { kind: "apply" }>["kind"];
type MediaRefusal = "invalid-media" | "invalid-poster";

export type GalleryCounts = { published: number; draft: number };
export type CreateGalleryItemResult = { kind: "created"; item: GalleryItemView } | { kind: PlanRefusal | MediaRefusal | "media-in-use" | "gallery-full" };
export type UpdateGalleryItemResult = { kind: "updated"; item: GalleryItemView } | { kind: PlanRefusal | "invalid-poster" | "not-found" };
export type ReorderGalleryResult = { kind: "reordered"; items: GalleryItemView[] } | { kind: "conflict" };
export type DeleteGalleryItemResult = { kind: "deleted" } | { kind: "not-found" } | { kind: "conflict" };

export type GalleryRouterDependencies = {
  listItems: (status: GalleryItemStatus | "all") => Promise<GalleryItemView[]>;
  getItem: (id: string) => Promise<GalleryItemView | null>;
  createItem: (input: GalleryItemInput, audit: AuditContext) => Promise<CreateGalleryItemResult>;
  updateItem: (id: string, patch: GalleryItemPatch, audit: AuditContext) => Promise<UpdateGalleryItemResult>;
  reorderItems: (ids: string[], audit: AuditContext) => Promise<ReorderGalleryResult>;
  deleteItem: (id: string, expectedUpdatedAt: string, audit: AuditContext) => Promise<DeleteGalleryItemResult>;
};

export type PublicGalleryDependencies = {
  listPublishedItems: () => Promise<PublicGalleryItem[]>;
};

const listQuerySchema = z.object({ status: z.enum([...galleryItemStatuses, "all"]).default("all") });

type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

const posterAssets = alias(mediaAssets, "poster_assets");

/** Items with their file URLs, in display order (position, then oldest first for ties). */
async function selectViews(executor: Executor, where?: SQL) {
  const rows = await executor
    .select({ item: galleryItems, mediaUrl: mediaAssets.publicUrl, mediaContentType: mediaAssets.contentType, posterUrl: posterAssets.publicUrl })
    .from(galleryItems)
    .innerJoin(mediaAssets, eq(galleryItems.mediaId, mediaAssets.id))
    .leftJoin(posterAssets, eq(galleryItems.posterMediaId, posterAssets.id))
    .where(where)
    .orderBy(asc(galleryItems.position), asc(galleryItems.createdAt))
    .limit(GALLERY_ITEM_LIMIT);
  return rows.map(({ item, ...files }): GalleryItemView => ({ ...item, ...files }));
}

async function viewById(executor: Executor, id: string) {
  const [view] = await selectViews(executor, eq(galleryItems.id, id));
  return view ?? null;
}

/** Creates and reorders take this lock so positions and the item limit are decided one at a time. */
async function lockGalleryStructure(tx: Transaction) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gallery_items'))`);
}

/**
 * FOR SHARE blocks a concurrent media delete until this transaction commits. The main
 * file must be a verified gallery upload; a poster must also be an image.
 */
async function lockGalleryMedia(tx: Transaction, id: string, role: "media" | "poster") {
  const conditions = [eq(mediaAssets.id, id), eq(mediaAssets.status, "verified"), eq(mediaAssets.intent, "gallery")];
  if (role === "poster") conditions.push(like(mediaAssets.contentType, "image/%"));
  const [asset] = await tx
    .select({ id: mediaAssets.id, contentType: mediaAssets.contentType })
    .from(mediaAssets)
    .where(and(...conditions))
    .for("share");
  return asset ?? null;
}

/**
 * A deleted item's files go with it, unless something else still uses them (a poster
 * can be shared). Marking them deleted lets the media maintenance job remove the objects.
 */
async function releaseFiles(tx: Transaction, ids: string[]) {
  for (const id of ids) {
    const [galleryUse] = await tx
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(or(eq(galleryItems.mediaId, id), eq(galleryItems.posterMediaId, id)))
      .limit(1);
    const [coverUse] = await tx.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.coverMediaId, id)).limit(1);
    if (galleryUse || coverUse) continue;
    const now = new Date();
    await tx.update(mediaAssets).set({ status: "deleted", deletedAt: now, updatedAt: now }).where(and(eq(mediaAssets.id, id), ne(mediaAssets.status, "deleted")));
  }
}

function buildProductionDependencies(): GalleryRouterDependencies & PublicGalleryDependencies {
  return {
    async listItems(status) {
      return selectViews(getDb(), status === "all" ? undefined : eq(galleryItems.status, status));
    },
    async getItem(id) {
      return viewById(getDb(), id);
    },
    async createItem(input, audit) {
      try {
        return await getDb().transaction(async (tx): Promise<CreateGalleryItemResult> => {
          await lockGalleryStructure(tx);
          const media = await lockGalleryMedia(tx, input.mediaId, "media");
          if (!media) return { kind: "invalid-media" };
          if (input.posterMediaId && !(await lockGalleryMedia(tx, input.posterMediaId, "poster"))) return { kind: "invalid-poster" };
          const [{ total, lastPosition }] = await tx
            .select({ total: sql<number>`count(*)::int`, lastPosition: sql<number>`coalesce(max(${galleryItems.position}), 0)::int` })
            .from(galleryItems);
          if (total >= GALLERY_ITEM_LIMIT) return { kind: "gallery-full" };

          const { mediaId, ...fields } = input;
          const type: GalleryItemType = mediaKindOf(media.contentType);
          const plan = planGalleryWrite(null, fields, { type, now: new Date(), actorId: audit.actorId });
          if (plan.kind !== "apply") return plan;
          const [item] = await tx
            .insert(galleryItems)
            .values({ mediaId, altText: input.altText, type, position: lastPosition + 1, ...plan.values })
            .returning();
          if (!item) throw new Error("Gallery item insert returned no row.");
          await recordAudit(tx, audit, { action: plan.action, entityType: "gallery_item", entityId: item.id, metadata: { type, status: plan.statusTo, fields: plan.fields } });
          const revalidation = revalidationForGalleryChange(null, item);
          if (revalidation) await queueRevalidation(tx, revalidation);
          const view = await viewById(tx, item.id);
          if (!view) throw new Error("Created gallery item could not be read back.");
          return { kind: "created", item: view };
        }).then(notifyAfterCommit);
      } catch (error) {
        if (isUniqueViolation(error, "gallery_items_media_id_unique")) return { kind: "media-in-use" };
        throw error;
      }
    },
    async updateItem(id, patch, audit) {
      return getDb().transaction(async (tx): Promise<UpdateGalleryItemResult> => {
        const [existing] = await tx.select().from(galleryItems).where(eq(galleryItems.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        const { expectedUpdatedAt, ...input } = patch;
        const posterChanged = input.posterMediaId !== undefined && input.posterMediaId !== existing.posterMediaId;
        if (posterChanged && input.posterMediaId && !(await lockGalleryMedia(tx, input.posterMediaId, "poster"))) return { kind: "invalid-poster" };
        const plan = planGalleryWrite(existing, input, { type: existing.type as GalleryItemType, now: new Date(), actorId: audit.actorId, expectedUpdatedAt });
        if (plan.kind !== "apply") return plan;
        const [item] = await tx.update(galleryItems).set(plan.values).where(eq(galleryItems.id, id)).returning();
        if (!item) return { kind: "not-found" };
        // A replaced poster is no longer needed unless another item shares it.
        if (posterChanged && existing.posterMediaId) await releaseFiles(tx, [existing.posterMediaId]);
        await recordAudit(tx, audit, {
          action: plan.action,
          entityType: "gallery_item",
          entityId: id,
          metadata: { fields: plan.fields, ...(plan.statusFrom !== plan.statusTo ? { statusFrom: plan.statusFrom, statusTo: plan.statusTo } : {}) },
        });
        const revalidation = revalidationForGalleryChange(existing, item);
        if (revalidation) await queueRevalidation(tx, revalidation);
        const view = await viewById(tx, id);
        if (!view) return { kind: "not-found" };
        return { kind: "updated", item: view };
      }).then(notifyAfterCommit);
    },
    async reorderItems(ids, audit) {
      return getDb().transaction(async (tx): Promise<ReorderGalleryResult> => {
        await lockGalleryStructure(tx);
        const current = await tx.select({ id: galleryItems.id, status: galleryItems.status }).from(galleryItems).for("update");
        if (!reorderMatches(current.map((row) => row.id), ids)) return { kind: "conflict" };
        // One statement, so no reader ever sees half an order.
        const positions = sql.join(ids.map((itemId, index) => sql`(${itemId}::uuid, ${index + 1}::int)`), sql`, `);
        await tx.execute(sql`
          UPDATE ${galleryItems} SET position = ordered.position
          FROM (VALUES ${positions}) AS ordered(id, position)
          WHERE ${galleryItems.id} = ordered.id
        `);
        await recordAudit(tx, audit, { action: "gallery.reorder", entityType: "gallery_item", entityId: null, metadata: { count: ids.length } });
        if (current.some((row) => row.status === "published")) await queueRevalidation(tx, { tags: [GALLERY_TAG], mode: "refresh" });
        return { kind: "reordered", items: await selectViews(tx) };
      }).then(notifyAfterCommit);
    },
    async deleteItem(id, expectedUpdatedAt, audit) {
      return getDb().transaction(async (tx): Promise<DeleteGalleryItemResult> => {
        const [existing] = await tx.select().from(galleryItems).where(eq(galleryItems.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        if (deleteConflicts(existing, expectedUpdatedAt)) return { kind: "conflict" };
        await tx.delete(galleryItems).where(eq(galleryItems.id, id));
        const files = [existing.mediaId, ...(existing.posterMediaId ? [existing.posterMediaId] : [])];
        await releaseFiles(tx, files);
        await recordAudit(tx, audit, { action: "gallery.delete", entityType: "gallery_item", entityId: id, metadata: { type: existing.type, statusFrom: existing.status, mediaIds: files } });
        const revalidation = revalidationForGalleryChange(existing, null);
        if (revalidation) await queueRevalidation(tx, revalidation);
        return { kind: "deleted" };
      }).then(notifyAfterCommit);
    },
    async listPublishedItems() {
      const views = await selectViews(getDb(), eq(galleryItems.status, "published"));
      return views.map(toPublicGalleryItem);
    },
  };
}

/** Wake the cache dispatcher once the write (and its queued purge) has committed. */
function notifyAfterCommit<T extends { kind: string }>(result: T) {
  if (["created", "updated", "reordered", "deleted"].includes(result.kind)) notifyRevalidationQueued();
  return result;
}

function countByStatus(items: GalleryItemView[]): GalleryCounts {
  return {
    published: items.filter((item) => item.status === "published").length,
    draft: items.filter((item) => item.status === "draft").length,
  };
}

function invalidItem(context: Context) {
  return context.json({ success: false as const, message: "Please check the gallery item details and try again.", responseCode: 400 }, 400);
}

const refusals: Record<PlanRefusal | MediaRefusal | "media-in-use" | "gallery-full" | "not-found", { status: 400 | 404 | 409 | 422; message: string }> = {
  "not-found": { status: 404, message: "Gallery item not found." },
  conflict: { status: 409, message: "This gallery item was changed by someone else. Reload to see the latest version." },
  "rights-required": { status: 422, message: "Confirm M&G owns this photo or video, and that anyone shown agreed to it, before publishing." },
  "poster-required": { status: 422, message: "Add a cover image before publishing this video." },
  "poster-not-allowed": { status: 400, message: "Only videos take a cover image." },
  "invalid-media": { status: 400, message: "Choose an uploaded photo or video that has finished processing." },
  "invalid-poster": { status: 400, message: "Choose an uploaded cover image that has finished processing." },
  "media-in-use": { status: 409, message: "That file is already in the gallery." },
  "gallery-full": { status: 409, message: `The gallery holds up to ${GALLERY_ITEM_LIMIT} items. Remove some before adding more.` },
};

function writeRefused(context: Context, kind: keyof typeof refusals) {
  const { status, message } = refusals[kind];
  return context.json({ success: false as const, message, responseCode: status }, status);
}

let productionDependencies: ReturnType<typeof buildProductionDependencies> | undefined;
const production = () => (productionDependencies ??= buildProductionDependencies());

/** Admin gallery management, mounted at `/v1/admin/gallery` behind the session check. Any admin may delete. */
export function createGalleryAdminRouter(dependencies: GalleryRouterDependencies = production()) {
  const router = new Hono<AdminVariables>();

  router.get("/", async (context) => {
    const parsed = listQuerySchema.safeParse({ status: context.req.query("status") || undefined });
    if (!parsed.success) return context.json({ success: false as const, message: "Invalid gallery filters.", responseCode: 400 }, 400);
    const items = await dependencies.listItems(parsed.data.status);
    const counts = parsed.data.status === "all" ? countByStatus(items) : countByStatus(await dependencies.listItems("all"));
    return context.json({ success: true as const, message: "Gallery loaded.", responseCode: 200, data: { items, counts, limit: GALLERY_ITEM_LIMIT } });
  });

  // Registered before `/:id` so "order" is never read as an id.
  router.put("/order", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = galleryReorderSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidItem(context);
    const result = await dependencies.reorderItems(parsed.data.ids, auditContextFrom(context, context.get("admin").id));
    if (result.kind === "conflict") {
      return context.json({ success: false as const, message: "The gallery changed since you loaded it. Reload and try again.", responseCode: 409 }, 409);
    }
    return context.json({ success: true as const, message: "Gallery order saved.", responseCode: 200, data: { items: result.items } });
  });

  router.get("/:id", async (context) => {
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const item = await dependencies.getItem(id.data);
    if (!item) return writeRefused(context, "not-found");
    return context.json({ success: true as const, message: "Gallery item loaded.", responseCode: 200, data: item });
  });

  router.post("/", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = galleryItemInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidItem(context);
    const result = await dependencies.createItem(parsed.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "created") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Gallery item saved.", responseCode: 201, data: result.item }, 201);
  });

  router.patch("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const parsed = galleryItemPatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidItem(context);
    const result = await dependencies.updateItem(id.data, parsed.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "updated") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Gallery item saved.", responseCode: 200, data: result.item });
  });

  router.delete("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const expected = expectedUpdatedAtSchema.safeParse(context.req.query("expectedUpdatedAt"));
    if (!expected.success) return invalidItem(context);
    const result = await dependencies.deleteItem(id.data, expected.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "deleted") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Gallery item deleted.", responseCode: 200, data: { deleted: true as const } });
  });

  return router;
}

/** Published gallery items for the website, mounted at `/v1/gallery`. Public fields only. */
export function createPublicGalleryRouter(dependencies: PublicGalleryDependencies = production()) {
  const router = new Hono();
  router.get("/", async (context) => {
    const items = await dependencies.listPublishedItems();
    return context.json({ success: true as const, message: "Published gallery loaded.", responseCode: 200, data: { items } });
  });
  return router;
}
