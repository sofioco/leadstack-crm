import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "./route";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  set: vi.fn(),
  issueNumber: vi.fn(),
  docs: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({ getUser: mocks.getUser }),
  getAdminDb: () => ({
    doc: (path: string) => ({ get: async () => ({ exists: mocks.docs.has(path), data: () => mocks.docs.get(path) }) }),
    collection: () => ({ doc: () => ({ id: "document-1", set: mocks.set }) }),
  }),
}));
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: mocks.issueNumber }));

// x-user-uid here represents the trusted identity injected by auth middleware.
function request(kind: string, authenticated = true) {
  return new Request("http://localhost/api/sub-accounts/workspace-1/quotes?SELF_HOSTED_MODE=true", {
    method: "POST",
    headers: { "content-type": "application/json", "x-self-hosted-mode": "true", ...(authenticated ? { "x-user-uid": "user-1" } : {}) },
    body: JSON.stringify({ kind, contactId: "contact-1", lineItems: [{ id: "line-1", productId: "product-1", description: "Service", quantity: 1, unitPrice: 100 }], selfHosted: true, agencyId: "spoofed-agency" }),
  });
}
const params = () => ({ params: Promise.resolve({ id: "workspace-1" }) });
const memberPath = "subAccounts/workspace-1/subAccountMembers/user-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.docs.clear();
  mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "owner", agencyId: "agency-1" } });
  mocks.docs.set("subAccounts/workspace-1", { agencyId: "agency-1" });
  mocks.docs.set("contacts/contact-1", { agencyId: "agency-1", subAccountId: "workspace-1", territoryId: "territory-a" });
  mocks.issueNumber.mockResolvedValue("DOC-001");
  mocks.set.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe.each([false, true])("unchanged quote/invoice authorization (self-hosted: %s)", (selfHosted) => {
  beforeEach(() => vi.stubEnv("SELF_HOSTED_MODE", selfHosted ? "true" : undefined));

  it.each(["quote", "invoice"])("allows an authorized agency owner to create a %s with verified tenant identity", async (kind) => {
    const response = await POST(request(kind), params());
    expect(response.status).toBe(201);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ kind, agencyId: "agency-1", subAccountId: "workspace-1", createdByUid: "user-1" }));
  });

  it.each(["quote", "invoice"])("rejects an unauthenticated %s request", async (kind) => {
    expect((await POST(request(kind, false), params())).status).toBe(401);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["quote", "invoice"])("rejects a different agency's owner for %s, despite browser entitlement input", async (kind) => {
    mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "owner", agencyId: "other-agency" } });
    expect((await POST(request(kind), params())).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["quote", "invoice"])("rejects a cross-workspace contact for %s", async (kind) => {
    mocks.docs.set("contacts/contact-1", { agencyId: "other-agency", subAccountId: "other-workspace" });
    expect((await POST(request(kind), params())).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("rejects inactive accounts", async () => {
    mocks.getUser.mockResolvedValue({ customClaims: { status: "inactive", agencyRole: "owner", agencyId: "agency-1" } });
    expect((await POST(request("quote"), params())).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("rejects inactive memberships", async () => {
    mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "member", agencyId: "agency-1" } });
    mocks.docs.set(memberPath, { status: "inactive", role: "admin" });
    expect((await POST(request("invoice"), params())).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("preserves active collaborator access without granting admin rights", async () => {
    mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "member", agencyId: "agency-1" } });
    mocks.docs.set(memberPath, { status: "active", role: "collaborator" });
    expect((await POST(request("quote"), params())).status).toBe(201);
    const adminAccess = await requireSubAccountAdmin(request("quote"), "workspace-1");
    expect(adminAccess).toBeInstanceOf(NextResponse);
    if (adminAccess instanceof NextResponse) expect(adminAccess.status).toBe(403);
  });

  it("preserves collaborator territory restrictions", async () => {
    mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "member", agencyId: "agency-1" } });
    mocks.docs.set(memberPath, { status: "active", role: "collaborator", assignedTerritoryIds: ["territory-b"] });
    mocks.docs.set("subAccounts/workspace-1", { agencyId: "agency-1", territoryScopingEnabled: true });
    expect((await POST(request("invoice"), params())).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
