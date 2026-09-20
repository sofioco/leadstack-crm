import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setClaims: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  verifyIdToken: vi.fn(),
  resolveAccess: vi.fn(),
  batchSet: vi.fn(),
  commit: vi.fn(),
  getAgency: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => {
  function doc(path: string) {
    return {
      id: path.split("/").at(-1),
      path,
      get: mocks.getAgency,
      collection: (name: string) => ({ doc: (id: string) => doc(`${path}/${name}/${id}`) }),
    };
  }
  const db = {
    doc,
    collection: (name: string) => ({ doc: () => doc(`${name}/${name}-1`) }),
    batch: () => ({ set: mocks.batchSet, commit: mocks.commit }),
    runTransaction: async (callback: (transaction: object) => Promise<unknown>) =>
      callback({ get: async () => ({ exists: false }) }),
  };
  return {
    getAdminDb: () => db,
    getAdminAuth: () => ({
      setCustomUserClaims: mocks.setClaims,
      getUser: mocks.getUser,
      createUser: mocks.createUser,
      deleteUser: mocks.deleteUser,
      verifyIdToken: mocks.verifyIdToken,
    }),
  };
});
vi.mock("@/lib/auth/resolve-agency-access", () => ({ resolveAgencyAccess: mocks.resolveAccess }));
vi.mock("@/lib/automations/seed-templates", () => ({ seedDefaultTemplates: vi.fn() }));
vi.mock("@/lib/provisioning/method-templates", () => ({ seedMethodTemplates: vi.fn() }));
vi.mock("@/lib/seed/sample-workspace", () => ({ seedSampleWorkspace: vi.fn() }));
vi.mock("@/lib/onboarding/lifecycle-email", () => ({ queueOnboardingLifecycleSequence: vi.fn() }));

import { isSelfHostedDeployment, requiresSubscription } from "./deployment-entitlement";
import { provisionNewAgency } from "./provision-agency";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as refreshClaims } from "@/app/api/auth/refresh-claims/route";
import { POST as oauthProvision } from "@/app/api/auth/oauth-provision/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SELF_HOSTED_MODE", undefined);
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "owner@example.test");
  mocks.createUser.mockResolvedValue({ uid: "owner-1" });
  mocks.getUser.mockResolvedValue({
    uid: "owner-1", email: "owner@example.test", displayName: "Owner",
    customClaims: { requiresEmailVerification: true, billingRequired: true, preservedClaim: "keep" },
  });
  mocks.verifyIdToken.mockResolvedValue({ uid: "owner-1", email: "owner@example.test" });
  mocks.resolveAccess.mockResolvedValue({
    agencyId: "agencies-1", agencyRole: "owner", status: "active", repairedPrimaryAgencyId: false,
  });
  mocks.getAgency.mockResolvedValue({ data: () => ({ subscriptionStatus: "inactive" }) });
});
afterEach(() => vi.unstubAllEnvs());

function request(path: string, body: object = {}, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

describe("deployment entitlement", () => {
  it.each([undefined, "false", "1", "TRUE", "true "])("requires billing unless explicitly enabled (%s)", (value) => {
    vi.stubEnv("SELF_HOSTED_MODE", value);
    expect(isSelfHostedDeployment()).toBe(false);
    expect(requiresSubscription()).toBe(true);
    expect(requiresSubscription("inactive")).toBe(true);
    expect(requiresSubscription("active")).toBe(false);
    expect(requiresSubscription("trialing")).toBe(false);
  });

  it("exempts self-hosted deployments without changing subscription state", () => {
    vi.stubEnv("SELF_HOSTED_MODE", "true");
    expect(isSelfHostedDeployment()).toBe(true);
    expect(requiresSubscription()).toBe(false);
    expect(requiresSubscription("inactive")).toBe(false);
  });
});

describe.each([false, true])("agency flows (self-hosted: %s)", (selfHosted) => {
  beforeEach(() => vi.stubEnv("SELF_HOSTED_MODE", selfHosted ? "true" : undefined));

  it("provisions owner and workspace with the correct billing and verification claims", async () => {
    await provisionNewAgency({ uid: "owner-1", email: "owner@example.test", displayName: "Owner", bootstrap: true, requiresEmailVerification: true });
    expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({
      agencyRole: "owner", status: "active", billingRequired: !selfHosted, requiresEmailVerification: true,
    }));
    expect(mocks.batchSet).toHaveBeenCalledWith(expect.objectContaining({ path: "agencies/agencies-1" }), expect.objectContaining({ subscriptionStatus: "inactive", ownerUid: "owner-1" }));
    expect(mocks.batchSet).toHaveBeenCalledWith(expect.objectContaining({ path: "subAccounts/subAccounts-1" }), expect.objectContaining({ agencyId: "agencies-1", status: "active" }));
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("returns the matching signup checkout decision", async () => {
    const response = await signup(request("/api/auth/signup", { email: "owner@example.test", password: "test-only-password" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requiresBilling: !selfHosted, redirectTo: selfHosted ? "/agency" : "/subscribe" });
    expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({ billingRequired: !selfHosted, requiresEmailVerification: true }));
  });

  it("recalculates stale billing claims without losing verification or changing roles", async () => {
    const response = await refreshClaims(request("/api/auth/refresh-claims", { selfHosted: !selfHosted }, { "x-user-uid": "owner-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claims: { billingRequired: !selfHosted, agencyRole: "owner", status: "active" } });
    expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({ billingRequired: !selfHosted, requiresEmailVerification: true, preservedClaim: "keep" }));
  });

  it("keeps existing OAuth owners on the same entitlement after sign-in", async () => {
    const response = await oauthProvision(request("/api/auth/oauth-provision", {}, { authorization: "Bearer test-token" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ existing: true, requiresBilling: !selfHosted, redirectTo: selfHosted ? "/agency" : "/subscribe" });
    expect(mocks.setClaims).toHaveBeenLastCalledWith("owner-1", expect.objectContaining({ billingRequired: !selfHosted, requiresEmailVerification: true }));
  });

  it("applies the same entitlement to newly provisioned OAuth agencies", async () => {
    mocks.resolveAccess.mockResolvedValue(null);
    const response = await oauthProvision(request("/api/auth/oauth-provision", {}, { authorization: "Bearer test-token" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ existing: false, requiresBilling: !selfHosted, redirectTo: selfHosted ? "/agency" : "/subscribe" });
    expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({ billingRequired: !selfHosted, requiresEmailVerification: true }));
  });

  it("clears stale owner billing claims for an existing non-owner without elevating access", async () => {
    mocks.resolveAccess.mockResolvedValue({ agencyId: "agencies-1", agencyRole: null, status: "active", repairedPrimaryAgencyId: false });
    const response = await oauthProvision(request("/api/auth/oauth-provision", {}, { authorization: "Bearer test-token" }));
    expect(await response.json()).toMatchObject({ requiresBilling: false, redirectTo: "/dashboard" });
    expect(mocks.setClaims).toHaveBeenLastCalledWith("owner-1", expect.objectContaining({
      role: "collaborator", agencyRole: null, billingRequired: false, requiresEmailVerification: true,
    }));
  });
});

it("does not accept self-hosted entitlement from signup body, query or headers", async () => {
  const response = await signup(request("/api/auth/signup?SELF_HOSTED_MODE=true", {
    email: "owner@example.test", password: "test-only-password", SELF_HOSTED_MODE: "true", selfHosted: true, billingRequired: false,
  }, { "x-self-hosted-mode": "true", "SELF_HOSTED_MODE": "true" }));
  expect(await response.json()).toMatchObject({ requiresBilling: true, redirectTo: "/subscribe" });
  expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({ billingRequired: true }));
});

it("still enforces the bootstrap email gate in self-hosted mode", async () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  const response = await signup(request("/api/auth/signup", { email: "other@example.test", password: "test-only-password" }));
  expect(response.status).toBe(403);
  expect(mocks.createUser).not.toHaveBeenCalled();
});

it("keeps an active hosted subscription entitled during refresh", async () => {
  mocks.getAgency.mockResolvedValue({ data: () => ({ subscriptionStatus: "active" }) });
  await refreshClaims(request("/api/auth/refresh-claims", {}, { "x-user-uid": "owner-1" }));
  expect(mocks.setClaims).toHaveBeenCalledWith("owner-1", expect.objectContaining({ billingRequired: false }));
});

it("does not grant owner status to a member during self-hosted claim refresh", async () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  mocks.resolveAccess.mockResolvedValue({ agencyId: "agencies-1", agencyRole: null, status: "active", repairedPrimaryAgencyId: false });
  await refreshClaims(request("/api/auth/refresh-claims", {}, { "x-user-uid": "member-1" }));
  expect(mocks.setClaims).toHaveBeenCalledWith("member-1", expect.objectContaining({ role: "collaborator", agencyRole: null, requiresEmailVerification: true }));
});

it("does not accept unauthenticated claim refresh in self-hosted mode", async () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  expect((await refreshClaims(request("/api/auth/refresh-claims"))).status).toBe(401);
  expect(mocks.setClaims).not.toHaveBeenCalled();
});
