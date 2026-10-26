import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";
import { publicUrlForKey } from "../media/policy.js";

export type PresignedUpload = {
  url: string;
  /** Headers the browser must send unchanged; they are part of the signature. */
  headers: Record<string, string>;
};

export type StoredObject = { exists: false } | { exists: true; size: number | null; contentType: string | null };

export interface MediaStorage {
  presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    cacheControl: string;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
  head(key: string): Promise<StoredObject>;
  readPrefix(key: string, byteCount: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
};

export function createR2Client(config: Pick<R2Config, "accountId" | "accessKeyId" | "secretAccessKey">) {
  // SDK >= 3.729 adds checksum parameters to PutObject by default; R2 and browser
  // presigned PUTs reject them (signature mismatch / CORS preflight), so only send when required.
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

function statusCodeOf(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

export function createR2Storage(config: R2Config, client = createR2Client(config)): MediaStorage {
  return {
    async presignPut({ key, contentType, contentLength, cacheControl, expiresInSeconds }) {
      const command = new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        CacheControl: cacheControl,
      });
      // Signing content-length binds the declared size, so R2 rejects a larger body
      // instead of storing it and leaving the size check to verification.
      const url = await getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(["content-type", "content-length", "cache-control"]),
      });
      return {
        url,
        headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
      };
    },
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
        return { exists: true, size: result.ContentLength ?? null, contentType: result.ContentType ?? null };
      } catch (error) {
        if (statusCodeOf(error) === 404) return { exists: false };
        throw error;
      }
    },
    async readPrefix(key, byteCount) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucketName, Key: key, Range: `bytes=0-${byteCount - 1}` }),
      );
      if (!result.Body) return new Uint8Array();
      return result.Body.transformToByteArray();
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
    },
    publicUrl(key) {
      return publicUrlForKey(config.publicUrl, key);
    },
  };
}

let storage: MediaStorage | undefined;

/** Lazily built so local development without R2 credentials can still run every other feature. */
export function getMediaStorage(): MediaStorage {
  if (storage) return storage;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    throw new MediaStorageUnavailableError();
  }
  storage = createR2Storage({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucketName: R2_BUCKET_NAME,
    publicUrl: R2_PUBLIC_URL,
  });
  return storage;
}

export class MediaStorageUnavailableError extends Error {
  constructor() {
    super("Media storage is not configured. Set the R2_* environment variables.");
    this.name = "MediaStorageUnavailableError";
  }
}
