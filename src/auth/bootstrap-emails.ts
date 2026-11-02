import { z } from "zod";

const emailSchema = z.string().email().max(320);

/**
 * Splits BOOTSTRAP_ADMIN_EMAIL into unique, lowercased addresses. Entries are separated by
 * commas; blanks are ignored. Throws naming the first entry that is not an email address.
 */
export function parseBootstrapEmails(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (!emailSchema.safeParse(entry).success) throw new Error(`BOOTSTRAP_ADMIN_EMAIL contains an invalid email address: "${entry}".`);
  }
  return [...new Set(entries)];
}
