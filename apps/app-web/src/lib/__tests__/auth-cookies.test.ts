import { describe, expect, it } from "vitest";
import { resolveCookieDomain } from "@/lib/auth-cookies";

describe("[COMP:app-web/auth-cookies] cookie domain", () => {
  it("uses host-only cookies when a production deployment explicitly clears the domain", () => {
    expect(resolveCookieDomain("", true)).toBeUndefined();
  });

  it("keeps the hosted production default when no override exists", () => {
    expect(resolveCookieDomain(undefined, true)).toBe(".usebrian.ai");
  });

  it("preserves a configured shared domain", () => {
    expect(resolveCookieDomain(".example.com", true)).toBe(".example.com");
  });
});
