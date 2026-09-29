import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth/password.js";

describe("admin password hashing", () => {
  it("verifies the password without storing it in plaintext", async () => {
    const password = "a-long-unique-demo-password";
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword("a-different-password", encoded)).resolves.toBe(false);
    await expect(verifyPassword(password, "invalid-hash")).resolves.toBe(false);
  });
});
