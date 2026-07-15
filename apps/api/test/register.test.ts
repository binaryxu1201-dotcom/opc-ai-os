import { describe, expect, it } from "vitest";
import { ApiError } from "../src/platform/errors.js";
import { validateRegistration } from "../src/auth/register.js";

describe("registration input validation", () => {
  const validInput = {
    email: "  User@Example.com ",
    password: "a-secure-password",
    termsVersion: "2026-07",
    privacyVersion: "2026-07"
  };

  it("normalizes email without creating workspace-scoped input", () => {
    expect(validateRegistration(validInput)).toEqual({
      email: "user@example.com",
      password: "a-secure-password",
      termsVersion: "2026-07",
      privacyVersion: "2026-07"
    });
  });

  it("requires at least one contact identifier", () => {
    expect(() => validateRegistration({ ...validInput, email: undefined })).toThrow(ApiError);
  });

  it("rejects non-E.164 phone numbers and bcrypt-overflow passwords", () => {
    expect(() => validateRegistration({ ...validInput, email: undefined, phone: "13800138000" })).toThrow(ApiError);
    expect(() => validateRegistration({ ...validInput, password: "a".repeat(73) })).toThrow(ApiError);
  });
});
