import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/**
 * Current scrypt cost: N=2^16, r=8, p=2 (one of OWASP's equivalent settings, about 64 MiB).
 * Parameters are stored in each hash, so they can be raised later and older hashes
 * upgraded at the next successful sign-in.
 */
export const SCRYPT_PARAMS = { N: 2 ** 16, r: 8, p: 2 } as const;
type ScryptParams = { N: number; r: number; p: number };

/** Hashes from before parameters were stored used Node's defaults. */
const LEGACY_PARAMS: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };

function deriveKey(password: string, salt: Buffer, params: ScryptParams) {
  // scrypt needs 128 * N * r bytes; allow headroom above Node's 32 MiB default.
  const maxmem = 128 * params.N * params.r * 2;
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, { ...params, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await deriveKey(password, salt, SCRYPT_PARAMS);
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

type ParsedHash = { params: ScryptParams; salt: Buffer; key: Buffer };

/** Reads `scrypt$N$r$p$salt$key` and the legacy `scrypt$salt$key`. */
function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  const [algorithm] = parts;
  if (algorithm !== "scrypt") return null;
  let params: ScryptParams;
  let saltHex: string | undefined;
  let keyHex: string | undefined;
  if (parts.length === 3) {
    [, saltHex, keyHex] = parts;
    params = LEGACY_PARAMS;
  } else if (parts.length === 6) {
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every((value) => Number.isInteger(value) && value > 0) || N > 2 ** 20 || r > 32 || p > 16) return null;
    params = { N, r, p };
    [saltHex, keyHex] = parts.slice(4);
  } else {
    return null;
  }
  if (!saltHex || !keyHex || !/^[a-f\d]{32}$/i.test(saltHex) || !/^[a-f\d]{128}$/i.test(keyHex)) return null;
  return { params, salt: Buffer.from(saltHex, "hex"), key: Buffer.from(keyHex, "hex") };
}

export async function verifyPassword(password: string, encoded: string) {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const actual = await deriveKey(password, parsed.salt, parsed.params);
  return timingSafeEqual(actual, parsed.key);
}

/** True when a stored hash uses weaker parameters than today's and should be replaced. */
export function needsRehash(encoded: string) {
  const parsed = parseHash(encoded);
  if (!parsed) return true;
  const { N, r, p } = parsed.params;
  return N < SCRYPT_PARAMS.N || r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p;
}

/** A hash of nothing in particular, verified for unknown emails so timing does not reveal them. */
export const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${"0".repeat(32)}$${"0".repeat(128)}`;
