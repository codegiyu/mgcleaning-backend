import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

export const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).optional(),
    ),
    FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    EMAIL_PROVIDER: z.enum(["resend", "smtp"]).default("smtp"),
    RESEND_API_KEY: optionalString,
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    EMAIL_FROM: z.string().email().default("notifications@example.com"),
    INQUIRY_NOTIFICATION_TO: z.string().email().default("inquiries@example.com"),
    INQUIRY_SECURITY_SECRET: z.string().min(16).default("development-inquiry-security-secret"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    INQUIRY_MAX_BODY_BYTES: z.coerce.number().int().positive().max(256_000).default(32_768),
    INQUIRY_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    INQUIRY_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().positive().default(5),
    INQUIRY_RATE_LIMIT_DAY_SECONDS: z.coerce.number().int().positive().default(86_400),
    INQUIRY_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(20),
    INQUIRY_IDENTITY_LIMIT_PER_DAY: z.coerce.number().int().positive().default(3),
    INQUIRY_FINGERPRINT_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
    INQUIRY_MAX_DATE_DAYS: z.coerce.number().int().positive().default(365),
    INQUIRY_MAX_EMAIL_ATTEMPTS: z.coerce.number().int().positive().default(5),
    TURNSTILE_MODE: z.enum(["off", "on"]).default("off"),
    TURNSTILE_SECRET_KEY: optionalString,
    TURNSTILE_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(3_000),
    R2_ACCOUNT_ID: optionalString,
    R2_ACCESS_KEY_ID: optionalString,
    R2_SECRET_ACCESS_KEY: optionalString,
    R2_BUCKET_NAME: optionalString,
    R2_FOLDER_PREFIX: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use a lowercase folder name such as staging-files.")
      .default("development-files"),
    R2_PUBLIC_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .url()
        .refine((value) => value.startsWith("https://") || value.startsWith("http://localhost"), "Use an HTTPS media URL.")
        .transform((value) => value.replace(/\/+$/, ""))
        .optional(),
    ),
    /** Shared with the website's /api/revalidate route; signs cache purge requests. */
    REVALIDATE_SECRET: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(32).optional()),
    /** Defaults to `${FRONTEND_ORIGIN}/api/revalidate`. */
    FRONTEND_REVALIDATE_URL: optionalUrl,
    MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;
    // Uploads are a core admin workflow in production; refuse to start without storage.
    // Without the secret an unpublished article would stay in the public cache for up to an hour.
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL", "REVALIDATE_SECRET"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production.` });
    }
  })
  .parse(process.env);
