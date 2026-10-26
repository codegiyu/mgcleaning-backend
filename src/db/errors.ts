type PostgresErrorShape = { code?: unknown; constraint_name?: unknown; cause?: unknown };

/** Drizzle wraps driver errors in `DrizzleQueryError`; walk the cause chain to find the Postgres error. */
function findPostgresError(error: unknown): PostgresErrorShape | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as PostgresErrorShape;
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
}

/** True only for a unique violation (SQLSTATE 23505), optionally on one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string) {
  const pgError = findPostgresError(error);
  if (!pgError || pgError.code !== "23505") return false;
  return constraint === undefined || pgError.constraint_name === constraint;
}

export const BLOG_POST_SLUG_CONSTRAINT = "blog_posts_slug_unique";
