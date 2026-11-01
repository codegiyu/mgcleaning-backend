import { pino, type DestinationStream, type Level, type Logger } from "pino";
import { env } from "./env.js";

/**
 * Paths that may carry customer or credential data. Redaction is a safety net:
 * call sites should still avoid logging request bodies or contact details.
 */
export const REDACTED_PATHS = [
  "name",
  "phone",
  "email",
  "password",
  "token",
  "cookie",
  "message",
  "*.name",
  "*.phone",
  "*.email",
  "*.password",
  "*.token",
  "*.cookie",
  "req.headers.cookie",
  "req.headers.authorization",
];

export function createLogger({
  destination,
  level = env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
}: { destination?: DestinationStream; level?: Level | "silent" } = {}): Logger {
  const options = {
    level,
    base: { service: "mgcleaning-backend" },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
