import { cors } from "hono/cors";
import { Hono } from "hono";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { REQUEST_ID_HEADER, requestContext, type RequestContextVariables } from "./request-context.js";
import { v1Router } from "./routes/v1/index.js";

export const app = new Hono<{ Variables: RequestContextVariables }>();

app.use("*", requestContext());

app.use(
  "/api/*",
  cors({
    origin: env.FRONTEND_ORIGIN,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", REQUEST_ID_HEADER],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: [REQUEST_ID_HEADER, "Retry-After"],
    credentials: true,
  }),
);

app.route("/api/v1", v1Router);

app.onError((error, context) => {
  (context.get("logger") ?? logger).error(
    { err: error, method: context.req.method, path: context.req.path },
    "unhandled API error",
  );

  return context.json(
    {
      success: false as const,
      message: "An unexpected server error occurred.",
      responseCode: 500,
    },
    500,
  );
});

export type AppType = typeof app;
