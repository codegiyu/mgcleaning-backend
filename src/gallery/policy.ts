import { z } from "zod";
import type { AuditAction } from "../audit/audit.js";
import {
  galleryItemStatuses,
  galleryLayouts,
  type GalleryItem,
  type GalleryItemStatus,
  type GalleryItemType,
  type NewGalleryItem,
} from "../db/schema/galleryItems.js";

/** The gallery is curated, not a feed: one bounded list, shown and reordered as a whole. */
export const GALLERY_ITEM_LIMIT = 300;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const LINK_PATTERN = /(?:https?:\/\/|www\.)/i;

/** One line of public text: no line breaks, markup, or links. */
function lineSchema(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !/[<>]/.test(value) && !CONTROL_CHARACTERS.test(value) && !LINK_PATTERN.test(value));
}

const optionalLine = (max: number) =>
  z
    .union([lineSchema(1, max), z.literal("")])
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const slugSchema = z.string().trim().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const galleryFields = {
  /** Describes what the photo or video shows, for screen readers and search. */
  altText: lineSchema(3, 250),
  caption: optionalLine(200),
  serviceSlug: slugSchema.nullable().optional(),
  tags: z
    .array(lineSchema(1, 40))
    .max(8)
    .transform((tags) => [...new Set(tags)])
    .optional(),
  layout: z.enum(galleryLayouts).optional(),
  status: z.enum(galleryItemStatuses).optional(),
  /** Still image shown before a video plays. */
  posterMediaId: z.string().uuid().nullable().optional(),
  /** The editor confirms M&G owns the media and anyone or any property shown agreed to it appearing. */
  rightsConfirmed: z.boolean().optional(),
};

/** The item's type comes from the uploaded file, so the client names the upload, not the type. */
export const galleryItemInputSchema = z.object({ mediaId: z.string().uuid(), ...galleryFields }).strict();

export const expectedUpdatedAtSchema = z.iso.datetime({ offset: true });

/** A patch names the version it was edited from, so concurrent edits are detected. The file itself is fixed. */
export const galleryItemPatchSchema = z
  .object(galleryFields)
  .partial()
  .extend({ expectedUpdatedAt: expectedUpdatedAtSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"));

/** The full order, top first. Every current item must appear exactly once. */
export const galleryReorderSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(GALLERY_ITEM_LIMIT) })
  .strict()
  .refine((value) => new Set(value.ids).size === value.ids.length);

export type GalleryItemInput = z.output<typeof galleryItemInputSchema>;
export type GalleryItemPatch = z.output<typeof galleryItemPatchSchema>;
export type GalleryItemFields = Omit<GalleryItemInput, "mediaId">;

export type GalleryWritePlan =
  | { kind: "apply"; values: Partial<NewGalleryItem>; action: AuditAction; statusFrom: GalleryItemStatus | null; statusTo: GalleryItemStatus; fields: string[] }
  | { kind: "conflict" }
  | { kind: "rights-required" }
  | { kind: "poster-required" }
  | { kind: "poster-not-allowed" };

type Existing = Pick<GalleryItem, "type" | "status" | "posterMediaId" | "rightsConfirmedAt" | "updatedAt">;

/**
 * Decide how a create (`existing` null) or patch is written. Publishing needs confirmed
 * rights and, for a video, a poster; rights cannot be withdrawn and a poster cannot be
 * removed while the item is live; and a patch based on an older version of the row is
 * refused rather than silently overwriting it. Only videos take a poster.
 */
export function planGalleryWrite(
  existing: Existing | null,
  input: Partial<GalleryItemFields>,
  options: { type: GalleryItemType; now: Date; actorId: string | null; expectedUpdatedAt?: string },
): GalleryWritePlan {
  const { type, now, actorId } = options;
  if (existing && Date.parse(options.expectedUpdatedAt ?? "") !== existing.updatedAt.getTime()) return { kind: "conflict" };

  const posterMediaId = input.posterMediaId === undefined ? (existing?.posterMediaId ?? null) : input.posterMediaId;
  if (type === "image" && posterMediaId) return { kind: "poster-not-allowed" };

  const statusFrom = existing ? (existing.status as GalleryItemStatus) : null;
  const statusTo = input.status ?? statusFrom ?? "draft";
  const rightsConfirmed = input.rightsConfirmed ?? Boolean(existing?.rightsConfirmedAt);
  if (statusTo === "published" && !rightsConfirmed) return { kind: "rights-required" };
  if (statusTo === "published" && type === "video" && !posterMediaId) return { kind: "poster-required" };

  const { rightsConfirmed: rightsChange, ...fields } = input;
  const values: Partial<NewGalleryItem> = { ...fields, status: statusTo, updatedBy: actorId, updatedAt: now };
  if (rightsChange === true && !existing?.rightsConfirmedAt) {
    values.rightsConfirmedAt = now;
    values.rightsConfirmedBy = actorId;
  }
  if (rightsChange === false) {
    values.rightsConfirmedAt = null;
    values.rightsConfirmedBy = null;
  }
  if (statusTo === "published" && statusFrom !== "published") values.publishedAt = now;
  if (statusTo !== "published") values.publishedAt = null;
  if (!existing) {
    values.type = type;
    values.createdBy = actorId;
    values.createdAt = now;
  }

  const action: AuditAction = !existing
    ? "gallery.create"
    : statusTo === "published" && statusFrom !== "published"
      ? "gallery.publish"
      : statusTo !== "published" && statusFrom === "published"
        ? "gallery.unpublish"
        : "gallery.update";
  const fieldNames = Object.keys(input).filter((key) => input[key as keyof GalleryItemFields] !== undefined).sort();
  return { kind: "apply", values, action, statusFrom, statusTo, fields: fieldNames };
}

/** A delete is refused when it is based on an older version of the row. */
export function deleteConflicts(existing: Pick<GalleryItem, "updatedAt">, expectedUpdatedAt: string) {
  return Date.parse(expectedUpdatedAt) !== existing.updatedAt.getTime();
}

/**
 * A reorder must name exactly the current items. Anything else means another editor
 * added or removed an item since this list was loaded, and applying it would leave
 * items without a position.
 */
export function reorderMatches(currentIds: string[], requestedIds: string[]) {
  if (currentIds.length !== requestedIds.length) return false;
  const current = new Set(currentIds);
  return requestedIds.every((id) => current.has(id));
}

/** An admin item with the URLs and types of its files, which the row only references. */
export type GalleryItemView = GalleryItem & {
  mediaUrl: string;
  mediaContentType: string;
  posterUrl: string | null;
};

/** What the public site may see: no rights, editor, or draft details. */
export type PublicGalleryItem = {
  id: string;
  type: GalleryItemType;
  src: string;
  poster: string | null;
  alt: string;
  caption: string | null;
  serviceSlug: string | null;
  tags: string[];
  layout: string;
};

export function toPublicGalleryItem(item: GalleryItemView): PublicGalleryItem {
  return {
    id: item.id,
    type: item.type as GalleryItemType,
    src: item.mediaUrl,
    poster: item.posterUrl,
    alt: item.altText,
    caption: item.caption,
    serviceSlug: item.serviceSlug,
    tags: item.tags,
    layout: item.layout,
  };
}
