import type { Context } from "hono";
import { z } from "zod";
import { env } from "../../env.js";

export type PageQuery = { page: number; pageSize: number; query?: string };

export const uuidSchema = z.string().uuid();
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  query: z.string().trim().max(120).optional(),
});

export function pageResult<T>(items: T[], total: number, query: PageQuery) {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export function parsePageQuery(context: Context) {
  return pageSchema.safeParse({
    page: context.req.query("page"),
    pageSize: context.req.query("pageSize"),
    query: context.req.query("query"),
  });
}

/** Admin writes must come from the configured website origin (CSRF defence alongside SameSite=Lax). */
export function trustedOrigin(context: Context) {
  const origin = context.req.header("origin");
  return origin === env.FRONTEND_ORIGIN;
}

export function forbiddenOrigin(context: Context) {
  return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
}
