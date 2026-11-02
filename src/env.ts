import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const DEV_INQUIRY_SECRET = "development-inquiry-security-secret";

const envSchema = z
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
    INQUIRY_SECURITY_SECRET: z.string().min(16).default(DEV_INQUIRY_SECRET),
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
    /** Comma-separated admin emails kept out of the Users list and activity log for everyone but themselves. */
    HIDDEN_ADMIN_EMAILS: z
      .string()
      .default("codegiyu@gmail.com")
      .transform((value) => value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
    MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;
    // Uploads are a core admin workflow in production; refuse to start without storage.
    // Without the secret an unpublished article would stay in the public cache for up to an hour.
    for (const key of ["DATABASE_URL", "REDIS_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL", "REVALIDATE_SECRET"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production.` });
    }
    // Development defaults must never reach production: they would sign requests with a
    // public secret, send alerts to nobody, and trust the wrong website origin.
    const refuse = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    if (value.INQUIRY_SECURITY_SECRET === DEV_INQUIRY_SECRET || value.INQUIRY_SECURITY_SECRET.length < 32) {
      refuse("INQUIRY_SECURITY_SECRET", "Set a random INQUIRY_SECURITY_SECRET of at least 32 characters in production.");
    }
    for (const key of ["EMAIL_FROM", "INQUIRY_NOTIFICATION_TO"] as const) {
      if (/@example\.(com|org|net)$/i.test(value[key])) refuse(key, `${key} must be a real address in production, not the example default.`);
    }
    if (!value.FRONTEND_ORIGIN.startsWith("https://")) refuse("FRONTEND_ORIGIN", "FRONTEND_ORIGIN must be the website's https:// origin in production.");
    if (value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) refuse("RESEND_API_KEY", "RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
  });

export type Env = z.output<typeof envSchema>;

/** Validate a set of variables; the server refuses to start when this throws. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}

export const env = parseEnv(process.env);
