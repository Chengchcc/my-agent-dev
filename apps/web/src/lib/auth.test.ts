import { describe, expect, test } from "bun:test";

// parseEnv requires BACKEND_AUTH_TOKEN; login's success path signs with
// SESSION_SECRET. CI has no .env, so the test must be self-contained.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

/** Fresh module instances per case so the module-level env cache does not
 *  leak between scenarios. Bun treats the query string as a distinct
 *  module URL. */
function freshAuth() {
  return import(`./auth.ts?case=${Math.random().toString(36).slice(2)}`);
}

describe("auth login (F3)", () => {
  test("without MOCK_PASSWORD the default admin password is rejected (fail-closed)", async () => {
    delete process.env.MOCK_PASSWORD;
    delete process.env.MOCK_USER_ID;
    const auth = await freshAuth();
    const result = await auth.login("admin");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("Invalid password");
  });

  test("a configured MOCK_PASSWORD signs in", async () => {
    process.env.MOCK_PASSWORD = "s3cret";
    const auth = await freshAuth();
    const result = await auth.login("s3cret");
    expect("cookie" in result).toBe(true);
    delete process.env.MOCK_PASSWORD;
  });

  test("timingSafeEqualPassword hashes before comparing", async () => {
    const auth = await freshAuth();
    expect(auth.timingSafeEqualPassword("same", "same")).toBe(true);
    expect(auth.timingSafeEqualPassword("same", "diff")).toBe(false);
    // Different lengths are safe (both sides hashed to 32 bytes first).
    expect(auth.timingSafeEqualPassword("a", "bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });
});
