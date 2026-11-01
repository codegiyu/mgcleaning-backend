import { describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "./db/schema/mediaAssets.js";
import { runMediaMaintenance } from "./media/maintenance.js";
import { buildMediaKey, matchesImageSignature, resolveImageUpload } from "./media/policy.js";
import { createAdminRouter, type AdminRouterDependencies } from "./routes/v1/admin.js";
import { createMediaRouter, sanitizeFilename, type MediaRouterDependencies, type PendingAssetInput } from "./routes/v1/media.js";
import { createR2Storage, MediaStorageUnavailableError, type MediaStorage, type StoredObject } from "./storage/r2.js";

const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test", role: "owner" as const, mustChangePassword: false };
const token = "a-session-token-used-only-in-this-test";
const assetId = "3f0d8a8e-2a4b-4c55-9d7e-6b1f2c3d4e5f";
const now = new Date("2026-10-26T12:00:00.000Z");
const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: assetId,
    key: "development-files/blog-cover/2026/10/abc123.webp",
    publicUrl: "https://media.example.test/development-files/blog-cover/2026/10/abc123.webp",
    intent: "blog-cover",
    contentType: "image/webp",
    declaredBytes: 2048,
    byteSize: null,
    altText: null,
    originalFilename: "sofa.webp",
    status: "pending",
    failureReason: null,
    uploadedBy: actor.id,
    expiresAt: new Date(now.getTime() + 15 * 60_000),
    verifiedAt: null,
    deletedAt: null,
    objectRemovedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeStorage(stored: StoredObject = { exists: true, size: 2048, contentType: "image/webp" }, prefix = WEBP_BYTES) {
  return {
    presignPut: vi.fn<MediaStorage["presignPut"]>(async ({ key, contentType, cacheControl }) => ({
      url: `https://bucket.r2.example.test/${key}?X-Amz-Signature=fake`,
      headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
    })),
    head: vi.fn<MediaStorage["head"]>(async () => stored),
    readPrefix: vi.fn<MediaStorage["readPrefix"]>(async () => prefix),
    delete: vi.fn<MediaStorage["delete"]>(async () => undefined),
    publicUrl: (key: string) => `https://media.example.test/${key}`,
  } satisfies MediaStorage;
}

function media(overrides: Partial<MediaRouterDependencies> = {}, storage: MediaStorage = fakeStorage()) {
  const dependencies: MediaRouterDependencies = {
    storage: () => storage,
    now: () => now,
    async createPending(input: PendingAssetInput) { return asset({ ...input, id: assetId }); },
    async getAsset() { return asset(); },
    async markVerified(_id, byteSize) { return asset({ status: "verified", byteSize, verifiedAt: now }); },
    async markFailed() {},
    async markExpired() {},
    async listVerified() { return { items: [asset({ status: "verified", byteSize: 2048 })], total: 1 }; },
    async updateAltText(_id, altText) { return asset({ status: "verified", altText }); },
    async softDelete() { return { kind: "deleted", asset: asset({ status: "deleted" }) }; },
    async markObjectRemoved() {},
    ...overrides,
  };
  const adminDefaults = {
    async resolveSession(value: string) { return value === token ? actor : null; },
  } as unknown as AdminRouterDependencies; // Only session resolution is exercised by media routes.
  return createAdminRouter(adminDefaults, createMediaRouter(dependencies));
}

const uploadRequest = { intent: "blog-cover", fileExtension: "webp", byteSize: 2048, filename: "C:\\Users\\me\\sofa.webp" };

describe("media upload URLs", () => {
  it("requires an admin session", async () => {
    const response = await media().request("/media/uploads", { method: "POST", body: JSON.stringify(uploadRequest), headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(401);
  });

  it("rejects requests from other origins", async () => {
    const response = await media().request("/media/uploads", { method: "POST", body: JSON.stringify(uploadRequest), headers: { ...headers, Origin: "https://attacker.example" } });
    expect(response.status).toBe(403);
  });

  it("refuses SVG and other non-raster types", async () => {
    for (const fileExtension of ["svg", "html", "gif"]) {
      const response = await media().request("/media/uploads", { method: "POST", headers, body: JSON.stringify({ ...uploadRequest, fileExtension }) });
      expect(response.status).toBe(400);
    }
  });

  it("refuses files over the size limit before signing", async () => {
    const storage = fakeStorage();
    const response = await media({}, storage).request("/media/uploads", { method: "POST", headers, body: JSON.stringify({ ...uploadRequest, byteSize: 50 * 1024 * 1024 }) });
    expect(response.status).toBe(413);
    expect(storage.presignPut).not.toHaveBeenCalled();
  });

  it("returns 503 when storage is not configured", async () => {
    const response = await media({ storage: () => { throw new MediaStorageUnavailableError(); } }).request("/media/uploads", { method: "POST", headers, body: JSON.stringify(uploadRequest) });
    expect(response.status).toBe(503);
  });

  it("signs a server-generated key with the declared size and derived type", async () => {
    const storage = fakeStorage();
    const createPending = vi.fn<MediaRouterDependencies["createPending"]>(async (input) => asset({ ...input }));
    const response = await media({ createPending }, storage).request("/media/uploads", { method: "POST", headers, body: JSON.stringify(uploadRequest) });
    const body = await response.json();

    expect(response.status).toBe(201);
    const signed = storage.presignPut.mock.calls[0]?.[0];
    expect(signed?.key).toMatch(/^development-files\/blog-cover\/2026\/10\/[a-z0-9]{16}\.webp$/);
    expect(signed).toMatchObject({ contentType: "image/webp", contentLength: 2048, cacheControl: "public, max-age=31536000, immutable" });
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ declaredBytes: 2048, contentType: "image/webp", originalFilename: "sofa.webp" }),
      expect.objectContaining({ actorId: actor.id }),
    );
    expect(body.data.upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/webp" } });
    expect(body.data.asset).not.toHaveProperty("key");
  });
});

describe("media verification", () => {
  async function verify(overrides: Partial<MediaRouterDependencies> = {}, storage: MediaStorage = fakeStorage()) {
    return media(overrides, storage).request(`/media/${assetId}/verify`, { method: "POST", headers });
  }

  it("verifies an object whose size, type, and bytes match", async () => {
    const markVerified = vi.fn<MediaRouterDependencies["markVerified"]>(async (_id, byteSize) => asset({ status: "verified", byteSize }));
    const response = await verify({ markVerified });
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("verified");
    expect(markVerified).toHaveBeenCalledWith(assetId, 2048, expect.objectContaining({ actorId: actor.id }));
  });

  it("is idempotent for an already verified asset", async () => {
    const storage = fakeStorage();
    const response = await verify({ async getAsset() { return asset({ status: "verified" }); } }, storage);
    expect(response.status).toBe(200);
    expect(storage.head).not.toHaveBeenCalled();
  });

  it("reports a concurrent verify as success when the row is already verified", async () => {
    let reads = 0;
    const response = await verify({
      async markVerified() { return null; },
      async getAsset() { reads += 1; return asset({ status: reads === 1 ? "pending" : "verified" }); },
    });
    expect(response.status).toBe(200);
  });

  it("fails a missing object without trying to delete it", async () => {
    const storage = fakeStorage({ exists: false });
    const markFailed = vi.fn(async () => undefined);
    const response = await verify({ markFailed }, storage);
    expect(response.status).toBe(422);
    expect(markFailed).toHaveBeenCalledWith(assetId, "object_missing");
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["size_mismatch", { exists: true, size: 4096, contentType: "image/webp" } as StoredObject, WEBP_BYTES],
    ["type_mismatch", { exists: true, size: 2048, contentType: "text/html" } as StoredObject, WEBP_BYTES],
    ["not_an_image", { exists: true, size: 2048, contentType: "image/webp" } as StoredObject, PNG_BYTES],
  ])("removes the object on %s", async (reason, stored, prefix) => {
    const storage = fakeStorage(stored, prefix);
    const markFailed = vi.fn(async () => undefined);
    const markObjectRemoved = vi.fn(async () => undefined);
    const response = await verify({ markFailed, markObjectRemoved }, storage);
    expect(response.status).toBe(422);
    expect(markFailed).toHaveBeenCalledWith(assetId, reason);
    expect(storage.delete).toHaveBeenCalledWith(asset().key);
    expect(markObjectRemoved).toHaveBeenCalledWith(assetId);
  });

  it("expires an upload whose window has passed", async () => {
    const markExpired = vi.fn(async () => undefined);
    const storage = fakeStorage();
    const response = await verify({ markExpired, async getAsset() { return asset({ expiresAt: new Date(now.getTime() - 1) }); } }, storage);
    expect(response.status).toBe(409);
    expect(markExpired).toHaveBeenCalledWith(assetId);
    expect(storage.head).not.toHaveBeenCalled();
  });

  it("hides deleted assets", async () => {
    const response = await verify({ async getAsset() { return asset({ status: "deleted" }); } });
    expect(response.status).toBe(404);
  });
});

describe("media library", () => {
  it("lists verified assets without storage keys", async () => {
    const response = await media().request("/media", { headers });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]).not.toHaveProperty("key");
  });

  it("refuses to delete an image used as a cover", async () => {
    const storage = fakeStorage();
    const response = await media({ async softDelete() { return { kind: "in-use" }; } }, storage).request(`/media/${assetId}`, { method: "DELETE", headers });
    expect(response.status).toBe(409);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("deletes the row and then the object", async () => {
    const storage = fakeStorage();
    const markObjectRemoved = vi.fn(async () => undefined);
    const response = await media({ markObjectRemoved }, storage).request(`/media/${assetId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith(asset().key);
    expect(markObjectRemoved).toHaveBeenCalledWith(assetId);
  });

  it("still succeeds when object removal fails, leaving it for cleanup", async () => {
    const storage = fakeStorage();
    storage.delete.mockRejectedValueOnce(new Error("R2 unavailable"));
    const markObjectRemoved = vi.fn(async () => undefined);
    const response = await media({ markObjectRemoved }, storage).request(`/media/${assetId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(markObjectRemoved).not.toHaveBeenCalled();
  });
});

describe("media policy", () => {
  it("derives the content type from the extension and normalises jpeg", () => {
    expect(resolveImageUpload("blog-cover", ".JPEG")).toEqual({ extension: "jpg", contentType: "image/jpeg" });
    expect(resolveImageUpload("blog-cover", "svg")).toBeNull();
  });

  it("builds date-partitioned keys under the environment prefix", () => {
    const key = buildMediaKey("staging-files", "blog-cover", "png", now);
    expect(key).toMatch(/^staging-files\/blog-cover\/2026\/10\/[a-z0-9]{16}\.png$/);
    expect(buildMediaKey("staging-files", "blog-cover", "png", now)).not.toBe(key);
  });

  it("matches image signatures to the declared type", () => {
    expect(matchesImageSignature("image/png", PNG_BYTES)).toBe(true);
    expect(matchesImageSignature("image/webp", WEBP_BYTES)).toBe(true);
    expect(matchesImageSignature("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesImageSignature("image/jpeg", PNG_BYTES)).toBe(false);
    expect(matchesImageSignature("image/png", new TextEncoder().encode("<html><script>"))).toBe(false);
  });

  it("keeps only a display-safe base filename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\My Sofa (1).webp")).toBe("My Sofa (1).webp");
    expect(sanitizeFilename("<script>.png")).toBe("_script_.png");
    expect(sanitizeFilename(undefined)).toBeNull();
  });
});

describe("R2 presigning", () => {
  it("signs size, type, and cache headers without checksum parameters", async () => {
    const storage = createR2Storage({
      accountId: "account123",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "example-secret",
      bucketName: "mg-media",
      publicUrl: "https://media.example.test",
    });
    const result = await storage.presignPut({
      key: "staging-files/blog-cover/2026/10/abc.webp",
      contentType: "image/webp",
      contentLength: 2048,
      cacheControl: "public, max-age=31536000, immutable",
      expiresInSeconds: 600,
    });
    const url = new URL(result.url);

    expect(url.hostname).toBe("mg-media.account123.r2.cloudflarestorage.com");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("cache-control;content-length;content-type;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect([...url.searchParams.keys()].some((key) => key.toLowerCase().includes("checksum"))).toBe(false);
    expect(result.headers).toEqual({ "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" });
  });
});

describe("media maintenance", () => {
  it("expires stale uploads and keeps going when one removal fails", async () => {
    const storage = fakeStorage();
    storage.delete.mockRejectedValueOnce(new Error("R2 unavailable"));
    const markObjectRemoved = vi.fn(async () => undefined);
    const result = await runMediaMaintenance({
      storage: () => storage,
      async expireStalePending() { return 2; },
      async listObjectsToRemove() { return [{ id: "a", key: "k/a.webp" }, { id: "b", key: "k/b.webp" }]; },
      markObjectRemoved,
    });

    expect(result).toEqual({ expired: 2, removed: 1, attempted: 2 });
    expect(markObjectRemoved).toHaveBeenCalledTimes(1);
    expect(markObjectRemoved).toHaveBeenCalledWith("b");
  });
});
