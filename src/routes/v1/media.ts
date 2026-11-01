import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditContextFrom, recordAudit, type AuditContext } from "../../audit/audit.js";
import { getDb } from "../../db/client.js";
import { blogPosts } from "../../db/schema/blogPosts.js";
import { mediaAssets, type MediaAsset } from "../../db/schema/mediaAssets.js";
import { env } from "../../env.js";
import {
  IMAGE_SIGNATURE_BYTES,
  IMMUTABLE_CACHE_CONTROL,
  buildMediaKey,
  matchesImageSignature,
  mediaIntents,
  resolveImageUpload,
  type MediaIntent,
} from "../../media/policy.js";
import { getRequestLogger } from "../../request-context.js";
import { getMediaStorage, MediaStorageUnavailableError, type MediaStorage } from "../../storage/r2.js";
import { forbiddenOrigin, pageResult, parsePageQuery, trustedOrigin, uuidSchema, type PageQuery } from "./admin-shared.js";

/** Upload URLs are short-lived; the pending row outlives them slightly so a slow PUT can still verify. */
export const UPLOAD_URL_SECONDS = 10 * 60;
const PENDING_GRACE_SECONDS = 5 * 60;

type AdminVariables = { Variables: { admin: { id: string; email: string } } };

export type PendingAssetInput = {
  key: string;
  publicUrl: string;
  intent: MediaIntent;
  contentType: string;
  declaredBytes: number;
  originalFilename: string | null;
  altText: string | null;
  expiresAt: Date;
};

export type DeleteAssetResult =
  | { kind: "deleted"; asset: MediaAsset }
  | { kind: "in-use" }
  | { kind: "not-found" };

export type MediaRouterDependencies = {
  storage: () => MediaStorage;
  now: () => Date;
  createPending: (input: PendingAssetInput, audit: AuditContext) => Promise<MediaAsset>;
  getAsset: (id: string) => Promise<MediaAsset | null>;
  /** Conditional on the row still being pending, so concurrent verifies record one upload. */
  markVerified: (id: string, byteSize: number, audit: AuditContext) => Promise<MediaAsset | null>;
  markFailed: (id: string, reason: string) => Promise<void>;
  markExpired: (id: string) => Promise<void>;
  listVerified: (query: PageQuery) => Promise<{ items: MediaAsset[]; total: number }>;
  updateAltText: (id: string, altText: string | null, audit: AuditContext) => Promise<MediaAsset | null>;
  softDelete: (id: string, audit: AuditContext) => Promise<DeleteAssetResult>;
  markObjectRemoved: (id: string) => Promise<void>;
};

const uploadRequestSchema = z
  .object({
    intent: z.enum(mediaIntents),
    fileExtension: z.string().trim().min(1).max(10),
    byteSize: z.number().int().positive(),
    filename: z.string().trim().max(200).optional(),
    altText: z.string().trim().max(250).optional(),
  })
  .strict();

const altTextSchema = z.object({ altText: z.string().trim().max(250).nullable() }).strict();

/** Keeps a display-only filename: no path segments or control characters. */
export function sanitizeFilename(value: string | undefined) {
  if (!value) return null;
  const base = value.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_").trim().slice(0, 200);
  return cleaned || null;
}

export function toMediaDto(asset: MediaAsset) {
  return {
    id: asset.id,
    url: asset.publicUrl,
    intent: asset.intent,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    altText: asset.altText,
    originalFilename: asset.originalFilename,
    status: asset.status,
    createdAt: asset.createdAt,
    verifiedAt: asset.verifiedAt,
  };
}

type VerifyOutcome =
  | { kind: "verified"; byteSize: number }
  | { kind: "failed"; reason: string; message: string; removeObject: boolean };

/** Checks the stored object against what was signed: existence, exact size, type, and leading bytes. */
export async function inspectUploadedObject(storage: MediaStorage, asset: MediaAsset, maxBytes: number): Promise<VerifyOutcome> {
  const stored = await storage.head(asset.key);
  if (!stored.exists) {
    return { kind: "failed", reason: "object_missing", message: "The file did not reach storage. Upload it again.", removeObject: false };
  }
  if (stored.size === null || stored.size !== asset.declaredBytes || stored.size > maxBytes) {
    return { kind: "failed", reason: "size_mismatch", message: "The uploaded file size did not match. Upload it again.", removeObject: true };
  }
  if (stored.contentType !== asset.contentType) {
    return { kind: "failed", reason: "type_mismatch", message: "The uploaded file type did not match. Upload it again.", removeObject: true };
  }
  const leadingBytes = await storage.readPrefix(asset.key, IMAGE_SIGNATURE_BYTES);
  if (!matchesImageSignature(asset.contentType, leadingBytes)) {
    return { kind: "failed", reason: "not_an_image", message: "That file is not a valid image.", removeObject: true };
  }
  return { kind: "verified", byteSize: stored.size };
}

function buildProductionDependencies(): MediaRouterDependencies {
  return {
    storage: getMediaStorage,
    now: () => new Date(),
    async createPending(input, audit) {
      const [asset] = await getDb()
        .insert(mediaAssets)
        .values({ ...input, status: "pending", uploadedBy: audit.actorId })
        .returning();
      if (!asset) throw new Error("Media asset insert returned no row.");
      return asset;
    },
    async getAsset(id) {
      const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
      return asset ?? null;
    },
    async markVerified(id, byteSize, audit) {
      return getDb().transaction(async (tx) => {
        const now = new Date();
        const [asset] = await tx
          .update(mediaAssets)
          .set({ status: "verified", byteSize, verifiedAt: now, updatedAt: now })
          .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "pending")))
          .returning();
        if (!asset) return null;
        await recordAudit(tx, audit, {
          action: "media.upload",
          entityType: "media_asset",
          entityId: id,
          metadata: { intent: asset.intent, contentType: asset.contentType, byteSize },
        });
        return asset;
      });
    },
    async markFailed(id, reason) {
      await getDb()
        .update(mediaAssets)
        .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "pending")));
    },
    async markExpired(id) {
      await getDb()
        .update(mediaAssets)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "pending")));
    },
    async listVerified(query) {
      const where = and(eq(mediaAssets.status, "verified"));
      const db = getDb();
      const [items, totals] = await Promise.all([
        db
          .select()
          .from(mediaAssets)
          .where(where)
          .orderBy(desc(mediaAssets.createdAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(mediaAssets).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    async updateAltText(id, altText, audit) {
      return getDb().transaction(async (tx) => {
        const [asset] = await tx
          .update(mediaAssets)
          .set({ altText, updatedAt: new Date() })
          .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "verified")))
          .returning();
        if (!asset) return null;
        await recordAudit(tx, audit, { action: "media.update", entityType: "media_asset", entityId: id, metadata: { fields: ["altText"] } });
        return asset;
      });
    },
    async softDelete(id, audit) {
      return getDb().transaction(async (tx): Promise<DeleteAssetResult> => {
        // Lock first, then check references in a separate statement: an editor attaching
        // this asset holds FOR SHARE, so this waits and then sees the committed reference.
        const [asset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, id)).for("update");
        if (!asset || asset.status === "deleted") return { kind: "not-found" };
        const [reference] = await tx
          .select({ id: blogPosts.id })
          .from(blogPosts)
          .where(eq(blogPosts.coverMediaId, id))
          .limit(1);
        if (reference) return { kind: "in-use" };
        const now = new Date();
        const [deleted] = await tx
          .update(mediaAssets)
          .set({ status: "deleted", deletedAt: now, updatedAt: now })
          .where(eq(mediaAssets.id, id))
          .returning();
        if (!deleted) return { kind: "not-found" };
        await recordAudit(tx, audit, { action: "media.delete", entityType: "media_asset", entityId: id, metadata: { previousStatus: asset.status } });
        return { kind: "deleted", asset: deleted };
      });
    },
    async markObjectRemoved(id) {
      await getDb().update(mediaAssets).set({ objectRemovedAt: sql`now()` }).where(eq(mediaAssets.id, id));
    },
  };
}

function storageUnavailable(context: Context) {
  return context.json(
    { success: false as const, message: "Image uploads are not configured on this server.", responseCode: 503 },
    503,
  );
}

function notFound(context: Context) {
  return context.json({ success: false as const, message: "Image not found.", responseCode: 404 }, 404);
}

export function createMediaRouter(dependencies: MediaRouterDependencies = buildProductionDependencies()) {
  const router = new Hono<AdminVariables>();

  router.post("/uploads", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = uploadRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Please check the image details and try again.", responseCode: 400 }, 400);
    }
    const upload = resolveImageUpload(parsed.data.intent, parsed.data.fileExtension);
    if (!upload) {
      return context.json({ success: false as const, message: "Use a JPG, PNG, or WebP image.", responseCode: 400 }, 400);
    }
    if (parsed.data.byteSize > env.MEDIA_MAX_UPLOAD_BYTES) {
      const limitMb = Math.floor(env.MEDIA_MAX_UPLOAD_BYTES / (1024 * 1024));
      return context.json({ success: false as const, message: `Images must be ${limitMb} MB or smaller.`, responseCode: 413 }, 413);
    }

    let storage: MediaStorage;
    try {
      storage = dependencies.storage();
    } catch (error) {
      if (error instanceof MediaStorageUnavailableError) return storageUnavailable(context);
      throw error;
    }

    const now = dependencies.now();
    const key = buildMediaKey(env.R2_FOLDER_PREFIX, parsed.data.intent, upload.extension, now);
    const presigned = await storage.presignPut({
      key,
      contentType: upload.contentType,
      contentLength: parsed.data.byteSize,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    const asset = await dependencies.createPending(
      {
        key,
        publicUrl: storage.publicUrl(key),
        intent: parsed.data.intent,
        contentType: upload.contentType,
        declaredBytes: parsed.data.byteSize,
        originalFilename: sanitizeFilename(parsed.data.filename),
        altText: parsed.data.altText || null,
        expiresAt: new Date(now.getTime() + (UPLOAD_URL_SECONDS + PENDING_GRACE_SECONDS) * 1_000),
      },
      auditContextFrom(context, context.get("admin").id),
    );

    return context.json(
      {
        success: true as const,
        message: "Upload URL issued.",
        responseCode: 201,
        data: {
          asset: toMediaDto(asset),
          upload: {
            url: presigned.url,
            method: "PUT" as const,
            headers: presigned.headers,
            expiresAt: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1_000).toISOString(),
          },
        },
      },
      201,
    );
  });

  router.post("/:id/verify", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = context.req.param("id");
    if (!uuidSchema.safeParse(id).success) return notFound(context);
    const asset = await dependencies.getAsset(id);
    if (!asset || asset.status === "deleted") return notFound(context);
    if (asset.status === "verified") {
      return context.json({ success: true as const, message: "Image ready.", responseCode: 200, data: toMediaDto(asset) });
    }
    if (asset.status !== "pending") {
      return context.json({ success: false as const, message: "This upload can no longer be used. Upload the image again.", responseCode: 409 }, 409);
    }
    if (dependencies.now() > asset.expiresAt) {
      await dependencies.markExpired(id);
      return context.json({ success: false as const, message: "This upload expired. Upload the image again.", responseCode: 409 }, 409);
    }

    let storage: MediaStorage;
    try {
      storage = dependencies.storage();
    } catch (error) {
      if (error instanceof MediaStorageUnavailableError) return storageUnavailable(context);
      throw error;
    }

    const outcome = await inspectUploadedObject(storage, asset, env.MEDIA_MAX_UPLOAD_BYTES);
    if (outcome.kind === "failed") {
      await dependencies.markFailed(id, outcome.reason);
      if (outcome.removeObject) {
        try {
          await storage.delete(asset.key);
          await dependencies.markObjectRemoved(id);
        } catch (error) {
          // The cleanup job retries removal for failed uploads.
          getRequestLogger(context).warn({ err: error, mediaId: id }, "failed upload object could not be removed");
        }
      }
      getRequestLogger(context).info({ mediaId: id, reason: outcome.reason }, "media upload rejected");
      return context.json({ success: false as const, message: outcome.message, responseCode: 422 }, 422);
    }

    const verified = await dependencies.markVerified(id, outcome.byteSize, auditContextFrom(context, context.get("admin").id));
    const current = verified ?? (await dependencies.getAsset(id));
    if (!current || current.status !== "verified") {
      return context.json({ success: false as const, message: "This upload can no longer be used. Upload the image again.", responseCode: 409 }, 409);
    }
    return context.json({ success: true as const, message: "Image ready.", responseCode: 200, data: toMediaDto(current) });
  });

  router.get("/", async (context) => {
    const parsed = parsePageQuery(context);
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Invalid image filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listVerified(parsed.data);
    return context.json({
      success: true as const,
      message: "Images loaded.",
      responseCode: 200,
      data: pageResult(result.items.map(toMediaDto), result.total, parsed.data),
    });
  });

  router.patch("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = context.req.param("id");
    const parsed = altTextSchema.safeParse(await context.req.json().catch(() => null));
    if (!uuidSchema.safeParse(id).success) return notFound(context);
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Alt text must be 250 characters or fewer.", responseCode: 400 }, 400);
    }
    const asset = await dependencies.updateAltText(id, parsed.data.altText || null, auditContextFrom(context, context.get("admin").id));
    if (!asset) return notFound(context);
    return context.json({ success: true as const, message: "Image updated.", responseCode: 200, data: toMediaDto(asset) });
  });

  router.delete("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = context.req.param("id");
    if (!uuidSchema.safeParse(id).success) return notFound(context);
    const result = await dependencies.softDelete(id, auditContextFrom(context, context.get("admin").id));
    if (result.kind === "not-found") return notFound(context);
    if (result.kind === "in-use") {
      return context.json({ success: false as const, message: "This image is used as an article cover. Replace it there first.", responseCode: 409 }, 409);
    }
    try {
      await dependencies.storage().delete(result.asset.key);
      await dependencies.markObjectRemoved(id);
    } catch (error) {
      // The row is already deleted for every reader; the cleanup job retries object removal.
      getRequestLogger(context).warn({ err: error, mediaId: id }, "deleted media object could not be removed");
    }
    return context.json({ success: true as const, message: "Image deleted.", responseCode: 200, data: { deleted: true as const } });
  });

  return router;
}
