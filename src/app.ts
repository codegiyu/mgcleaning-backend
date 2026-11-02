import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { Hono } from "hono";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { REQUEST_ID_HEADER, requestContext, type RequestContextVariables } from "./request-context.js";
import { v1Router } from "./routes/v1/index.js";

export const app = new Hono<{ Variables: RequestContextVariables }>();

app.use("*", requestContext());

// The API only returns JSON: nothing in a response should ever load, run, or be framed.
// Resources are same-site, not same-origin, because the website calls the API from its own origin.
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    crossOriginResourcePolicy: "same-site",
    strictTransportSecurity: env.NODE_ENV === "production" ? "max-age=31536000; includeSubDomains" : false,
  }),
);

app.use(
  "/api/*",
  cors({
    // Echoes the request's Origin only when it is listed (and sends Vary: Origin), so each
    // allowed website gets its own Access-Control-Allow-Origin and others get none.
    origin: env.FRONTEND_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", REQUEST_ID_HEADER],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: [REQUEST_ID_HEADER, "Retry-After"],
    credentials: true,
  }),
);

app.route("/api/v1", v1Router);

app.notFound((context) =>
  context.json({ success: false as const, message: "Not found.", responseCode: 404 }, 404),
);

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
