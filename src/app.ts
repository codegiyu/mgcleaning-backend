import { cors } from "hono/cors";
import { Hono } from "hono";
import { env } from "./env.js";
import { v1Router } from "./routes/v1/index.js";

export const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: env.FRONTEND_ORIGIN,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.route("/api/v1", v1Router);

app.onError((error, context) => {
  console.error("Unhandled API error", {
    name: error.name,
    method: context.req.method,
    path: context.req.path,
  });

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
