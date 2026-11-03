import { randomBytes } from "node:crypto";

export const mediaIntents = ["blog-cover", "gallery"] as const;
export type MediaIntent = (typeof mediaIntents)[number];

/**
 * Raster images and browser-playable video only. SVG is excluded because it can carry
 * script, and MOV because iPhone HEVC clips do not play in most browsers. The content
 * type is always derived here from the extension, never from the client.
 */
const MEDIA_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
} as const;
export type MediaExtension = keyof typeof MEDIA_TYPES;
export type MediaKind = "image" | "video";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const satisfies readonly MediaExtension[];

export const ALLOWED_EXTENSIONS_BY_INTENT: Record<MediaIntent, readonly MediaExtension[]> = {
  "blog-cover": IMAGE_EXTENSIONS,
  gallery: [...IMAGE_EXTENSIONS, "mp4", "webm"],
};

/** New key per upload, so public objects are immutable and can be cached forever. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function normalizeExtension(value: string) {
  return value.trim().replace(/^\./, "").toLowerCase();
}

export function mediaKindOf(contentType: string): MediaKind {
  return contentType.startsWith("video/") ? "video" : "image";
}

export function resolveMediaUpload(intent: MediaIntent, fileExtension: string) {
  const extension = normalizeExtension(fileExtension);
  if (!(ALLOWED_EXTENSIONS_BY_INTENT[intent] as readonly string[]).includes(extension)) return null;
  const typedExtension = extension as MediaExtension;
  const contentType = MEDIA_TYPES[typedExtension];
  return { extension: typedExtension === "jpeg" ? "jpg" : typedExtension, contentType, kind: mediaKindOf(contentType) };
}

export type UploadLimits = { imageBytes: number; videoBytes: number };

export function maxBytesFor(contentType: string, limits: UploadLimits) {
  return mediaKindOf(contentType) === "video" ? limits.videoBytes : limits.imageBytes;
}

const KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomName(length: number) {
  const bytes = randomBytes(length);
  let name = "";
  for (const byte of bytes) name += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return name;
}

/** `{prefix}/{intent}/{yyyy}/{mm}/{random}.{ext}`: server-generated, never derived from the client filename. */
export function buildMediaKey(prefix: string, intent: MediaIntent, extension: string, now: Date) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${prefix}/${intent}/${year}/${month}/${randomName(16)}.${extension}`;
}

export function publicUrlForKey(baseUrl: string, key: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

/**
 * Checks leading bytes so a renamed file cannot be verified as an image or video.
 * MP4 starts with a box size then `ftyp`; WebM starts with the EBML header.
 */
export function matchesMediaSignature(contentType: string, bytes: Uint8Array) {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((value, index) => bytes[offset + index] === value);
  if (contentType === "image/jpeg") return startsWith([0xff, 0xd8, 0xff]);
  if (contentType === "image/png") return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === "image/webp") return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8);
  if (contentType === "video/mp4") return startsWith([0x66, 0x74, 0x79, 0x70], 4);
  if (contentType === "video/webm") return startsWith([0x1a, 0x45, 0xdf, 0xa3]);
  return false;
}

export const MEDIA_SIGNATURE_BYTES = 12;
