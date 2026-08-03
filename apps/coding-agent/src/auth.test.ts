import { describe, expect, test } from "bun:test";
import { bearerToken, verifyToken } from "./auth.js";

describe("daemon auth", () => {
  test("valid token passes", () => {
    expect(verifyToken("secret-token", "secret-token")).toBe(true);
  });

  test("incorrect token fails", () => {
    expect(verifyToken("secret-token", "wrong-token")).toBe(false);
  });

  test("missing token fails", () => {
    expect(verifyToken("secret-token", null)).toBe(false);
    expect(verifyToken("secret-token", "")).toBe(false);
  });

  test("wrong length fails", () => {
    expect(verifyToken("secret-token", "short")).toBe(false);
    expect(verifyToken("secret-token", "this-token-is-much-longer-than-the-config")).toBe(false);
  });

  test("bearer extraction", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});
