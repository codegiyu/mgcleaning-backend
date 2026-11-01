import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, SCRYPT_PARAMS, verifyPassword } from "./auth/password.js";

/** A hash in the original `scrypt$salt$key` format with Node's default parameters. */
function legacyHash(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
}

describe("admin password hashing", () => {
  it("verifies the password without storing it in plaintext", async () => {
    const password = "a-long-unique-demo-password";
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(new RegExp(`^scrypt\\$${SCRYPT_PARAMS.N}\\$${SCRYPT_PARAMS.r}\\$${SCRYPT_PARAMS.p}\\$`));
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword("a-different-password", encoded)).resolves.toBe(false);
    await expect(verifyPassword(password, "invalid-hash")).resolves.toBe(false);
  });

  it("still verifies hashes made before parameters were stored, and flags them for upgrade", async () => {
    const encoded = legacyHash("an-older-admin-password");
    await expect(verifyPassword("an-older-admin-password", encoded)).resolves.toBe(true);
    expect(needsRehash(encoded)).toBe(true);
    expect(needsRehash(await hashPassword("a-current-admin-password"))).toBe(false);
  });

  it("rejects hashes with absurd parameters instead of burning memory on them", async () => {
    await expect(verifyPassword("x", `scrypt$${2 ** 30}$8$1$${"0".repeat(32)}$${"0".repeat(128)}`)).resolves.toBe(false);
  });

  it("uses a dummy hash with current parameters so unknown emails take as long as real ones", async () => {
    expect(needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
    await expect(verifyPassword("anything", DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });
});
