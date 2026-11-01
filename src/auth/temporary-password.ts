import { randomInt } from "node:crypto";

/** No 0/O, 1/l/I: the owner reads this out or types it into a message. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A one-time password for a new or reset account, e.g. "Hk7q-mP3x-9wTz-c4Rn": 16 random
 * characters (about 92 bits) in groups of four. The account must replace it at first sign-in.
 */
export function generateTemporaryPassword() {
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
  return groups.join("-");
}
