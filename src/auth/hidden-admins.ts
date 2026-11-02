import { env } from "../env.js";

/** Shown in the activity log in place of a hidden account's email. */
export const HIDDEN_ACTOR_LABEL = "Site administrator";

/** True when `email` is a hidden account and the signed-in admin is someone else. */
export function isHiddenFrom(email: string, viewerEmail: string, hidden: readonly string[] = env.HIDDEN_ADMIN_EMAILS) {
  const target = email.trim().toLowerCase();
  return hidden.includes(target) && target !== viewerEmail.trim().toLowerCase();
}
