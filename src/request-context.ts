import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { logger as rootLogger } from "./logger.js";

export const REQUEST_ID_HEADER = "X-Request-Id";
const INCOMING_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export type RequestContextVariables = { requestId: string; logger: Logger };

/** Accepts a well-formed upstream request ID or issues one, echoes it, and logs one line per request. */
export function requestContext(baseLogger: Logger = rootLogger): MiddlewareHandler<{ Variables: RequestContextVariables }> {
  return async (context, next) => {
    const incoming = context.req.header(REQUEST_ID_HEADER);
    const requestId = incoming && INCOMING_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const requestLogger = baseLogger.child({ requestId });
    context.set("requestId", requestId);
    context.set("logger", requestLogger);
    context.header(REQUEST_ID_HEADER, requestId);

    const startedAt = performance.now();
    await next();
    requestLogger.info(
      {
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "request completed",
    );
  };
}

/** The request-scoped logger, or the root logger when a router runs outside the app (unit tests, scripts). */
export function getRequestLogger(context: Context): Logger {
  return (context.get("logger") as Logger | undefined) ?? rootLogger;
}
