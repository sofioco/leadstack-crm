import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { authMiddleware as AuthMiddleware } from "next-firebase-auth-edge/lib/next/middleware";
import { InvalidTokenReason } from "next-firebase-auth-edge/lib/auth/error";

const mocks = vi.hoisted(() => ({ authMiddleware: vi.fn() }));
vi.mock("next-firebase-auth-edge/lib/next/middleware", () => ({ authMiddleware: mocks.authMiddleware }));

import middleware from "./middleware";

type Options = Parameters<typeof AuthMiddleware>[1];
type ValidTokenInput = Parameters<NonNullable<Options["handleValidToken"]>>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SELF_HOSTED_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "test-only");
  vi.stubEnv("FIREBASE_ADMIN_PROJECT_ID", "demo-test");
});
afterEach(() => vi.unstubAllEnvs());

async function optionsFor(path: string, headers: Record<string, string> = {}): Promise<Options> {
  await middleware(new NextRequest(`http://localhost${path}`, { headers }));
  expect(mocks.authMiddleware).toHaveBeenCalledTimes(1);
  return mocks.authMiddleware.mock.calls[0][1];
}

function owner(emailVerified = true): ValidTokenInput {
  return {
    token: "verified-test-token",
    metadata: {},
    decodedToken: {
      uid: "owner-1", sub: "owner-1", email: "owner@example.test", email_verified: emailVerified,
      aud: "demo-test", iss: "https://securetoken.google.com/demo-test", auth_time: 1, iat: 1, exp: 9999999999,
      firebase: { identities: {}, sign_in_provider: "password" },
      source_sign_in_provider: "password",
      role: "admin", status: "active", agencyId: "agency-1", agencyRole: "owner",
      billingRequired: true, requiresEmailVerification: true,
    },
  };
}

describe("subscription middleware", () => {
  it("still redirects a hosted owner who requires billing", async () => {
    const options = await optionsFor("/agency");
    const response = await options.handleValidToken!(owner(), new Headers());
    expect(response.headers.get("location")).toBe("http://localhost/subscribe");
  });

  it.each(["/agency", "/agency/sub-accounts/new", "/sa/workspace-1/dashboard", "/sa/workspace-1/quotes", "/sa/workspace-1/quotes/new?kind=invoice", "/sa/workspace-1/products", "/api/sub-accounts/workspace-1/quotes"])("allows a verified self-hosted owner through %s despite a stale billing claim", async (path) => {
    vi.stubEnv("SELF_HOSTED_MODE", "true");
    const options = await optionsFor(path);
    const headers = new Headers({ "x-user-uid": "spoofed" });
    const response = await options.handleValidToken!(owner(), headers);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(headers.get("x-user-uid")).toBe("owner-1");
  });

  it("still requires email verification in self-hosted mode", async () => {
    vi.stubEnv("SELF_HOSTED_MODE", "true");
    const options = await optionsFor("/agency");
    const response = await options.handleValidToken!(owner(false), new Headers());
    expect(response.headers.get("location")).toBe("http://localhost/verify-email");
  });

  it("does not grant self-hosted access based on browser headers or query", async () => {
    const options = await optionsFor("/agency?SELF_HOSTED_MODE=true", { "x-self-hosted-mode": "true", "SELF_HOSTED_MODE": "true" });
    const response = await options.handleValidToken!(owner(), new Headers());
    expect(new URL(response.headers.get("location")!).pathname).toBe("/subscribe");
  });

  it("still redirects unauthenticated self-hosted requests to login", async () => {
    vi.stubEnv("SELF_HOSTED_MODE", "true");
    const options = await optionsFor("/agency");
    const response = await options.handleInvalidToken!(InvalidTokenReason.MISSING_CREDENTIALS);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});
