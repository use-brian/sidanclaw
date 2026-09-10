import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, resolveAppLoginReturn } from "../route";
import { webAppUrl } from "@/lib/primary-auth";
import { ossSignedOutRedirect } from "@/lib/oss-entry";

vi.mock("@/lib/primary-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/primary-auth")>();
  return { ...actual, webAppUrl: vi.fn() };
});
vi.mock("@/lib/oss-entry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/oss-entry")>();
  return { ...actual, ossSignedOutRedirect: vi.fn() };
});

const mockedWebAppUrl = vi.mocked(webAppUrl);
const mockedOssEntry = vi.mocked(ossSignedOutRedirect);

beforeEach(() => {
  mockedWebAppUrl.mockReset();
  mockedWebAppUrl.mockReturnValue("https://usebrian.ai");
  mockedOssEntry.mockReset();
  mockedOssEntry.mockReturnValue(null);
});

afterEach(() => vi.unstubAllEnvs());

describe("[COMP:app-web/login-delegation] GET /login", () => {
  it.each(["", "?next=%2Fw%2Ftest&addAccount=1&error=auth_failed"])("delegates Outpost login to auth rather than the app origin (%s)", (query) => {
    const app = "https://brian-test.awcjack.top";
    const auth = "https://brian-test-auth.awcjack.top";
    vi.stubEnv("USEBRIAN_EDITION", "outpost");
    vi.stubEnv("PUBLIC_APP_URL", app);
    vi.stubEnv("AUTHED_APP_URL", app);
    vi.stubEnv("PUBLIC_PRIMARY_AUTH_URL", auth);
    mockedWebAppUrl.mockReturnValue(app);

    const res = GET(new Request(`http://localhost:3003/login${query}`));
    const target = new URL(res.headers.get("location")!);

    expect(res.status).toBe(307);
    expect(target.origin).toBe(auth);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(`${app}${query ? "/w/test" : "/"}`);
    expect(target.searchParams.get("addAccount")).toBe(query ? "1" : null);
    expect(target.searchParams.get("error")).toBe(query ? "auth_failed" : null);
    expect(mockedWebAppUrl).not.toHaveBeenCalled();
  });

  it("server-redirects hosted users to the canonical login without rendering HTML", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("USEBRIAN_EDITION", "hosted");
    vi.stubEnv("PUBLIC_PRIMARY_AUTH_URL", "");
    mockedWebAppUrl.mockReturnValue("https://app.usebrian.ai");
    const res = GET(new Request("https://app.usebrian.ai/login"));
    const target = new URL(res.headers.get("location")!);

    expect(res.status).toBe(307);
    expect(target.origin).toBe("https://usebrian.ai");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("https://app.usebrian.ai/");
    expect(mockedWebAppUrl).not.toHaveBeenCalled();
  });

  it("honors the legacy hosted primary and canonical app origin", () => {
    vi.stubEnv("USEBRIAN_EDITION", "hosted");
    vi.stubEnv("NEXT_PUBLIC_PRIMARY_AUTH_URL", "https://auth.preview.example");
    vi.stubEnv("NEXT_PUBLIC_AUTHED_APP_URL", "https://app.preview.example");
    const res = GET(new Request("http://localhost:3003/login?next=%2Fw%2Fone"));
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe("https://auth.preview.example");
    expect(target.searchParams.get("next")).toBe("https://app.preview.example/w/one");
  });

  it("preserves a same-origin return, add-account intent, and a safe error", () => {
    const source = new URL("https://app.usebrian.ai/login");
    source.searchParams.set("next", "/desktop/auth?challenge=abcdefghijklmnop");
    source.searchParams.set("addAccount", "1");
    source.searchParams.set("error", "auth_failed");

    const res = GET(new Request(source));
    const target = new URL(res.headers.get("location")!);

    expect(target.searchParams.get("next")).toBe(
      "https://app.usebrian.ai/desktop/auth?challenge=abcdefghijklmnop",
    );
    expect(target.searchParams.get("addAccount")).toBe("1");
    expect(target.searchParams.get("error")).toBe("auth_failed");
  });

  it("collapses an off-origin or protocol-relative return to the app root", () => {
    const requestUrl = new URL("https://app.usebrian.ai/login");
    expect(
      resolveAppLoginReturn(requestUrl, "https://evil.example/phish").toString(),
    ).toBe("https://app.usebrian.ai/");
    expect(resolveAppLoginReturn(requestUrl, "//evil.example/phish").toString()).toBe(
      "https://app.usebrian.ai/",
    );
  });

  it("routes a proxied OSS login to its public local-owner session", () => {
    vi.stubEnv("APP_URL", "https://hinson.usebrian.ai");
    mockedOssEntry.mockReturnValue(
      "/api/auth/local-session?next=%2Fw%2Fabc%2Fp",
    );

    const res = GET(
      new Request("http://localhost:3003/login?next=%2Fw%2Fabc%2Fp"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://hinson.usebrian.ai/api/auth/local-session?next=%2Fw%2Fabc%2Fp",
    );
    expect(mockedWebAppUrl).not.toHaveBeenCalled();
  });

  it("fails safely when Outpost has no customer auth primary", async () => {
    vi.stubEnv("NEXT_PUBLIC_USEBRIAN_EDITION", "outpost");

    const res = GET(new Request("https://app.private.example/login"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "auth_primary_unconfigured" });
    expect(mockedWebAppUrl).not.toHaveBeenCalled();
  });
});
