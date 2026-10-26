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
  })
  .parse(process.env);
