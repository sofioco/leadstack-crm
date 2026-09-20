import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: vi.fn(() => ({
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ data: () => ({ name: "Test workspace" }) })),
    })),
  })),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: vi.fn(),
  requireSubAccountAdmin: vi.fn(),
}));

let signingKey: string;

function accessToken(expiresAt = Math.floor(Date.now() / 1000) + 60) {
  const payload = Buffer.from(JSON.stringify({
    type: "access", exp: expiresAt, uid: "operator-1", email: "operator@example.test",
  })).toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function toolRequest(headers: Record<string, string>) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "agentstack_get_workspace_status", arguments: { subAccountId: "workspace-1" } },
    }),
  });
}

describe("MCP endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signingKey = randomBytes(32).toString("hex");
    vi.stubEnv("MCP_OAUTH_SECRET", signingKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes an authenticated MCP session", async () => {
    const res = await POST(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { serverInfo: { name: "agentstack" }, capabilities: { tools: {} } } });
  });

  it("lists only the guarded AS tools", async () => {
    const res = await POST(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }));
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "agentstack_get_workspace_status",
      "agentstack_find_featured_listing",
      "agentstack_build_property_campaign",
    ]);
  });

  it.each<[string, () => Record<string, string>]>([
    ["missing bearer", () => ({})],
    ["invalid bearer", () => ({ authorization: "Bearer invalid-token" })],
    ["expired bearer", () => ({ authorization: `Bearer ${accessToken(1)}` })],
    ["tampered bearer", () => ({ authorization: `Bearer ${accessToken()}tampered` })],
    ["spoofed identity without bearer", () => ({ "x-user-uid": "victim" })],
    ["spoofed identity with invalid bearer", () => ({ authorization: "Bearer invalid-token", "x-user-uid": "victim" })],
    ["spoofed identity with non-bearer authorization", () => ({ authorization: "Basic invalid", "x-user-uid": "victim" })],
  ])("rejects %s before executing a tool", async (_name, headers) => {
    const res = await POST(toolRequest(headers()));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
    expect(requireSubAccountMember).not.toHaveBeenCalled();
    expect(getAdminDb).not.toHaveBeenCalled();
  });

  it.each([false, true])("executes tools as the verified bearer identity (spoofed headers: %s)", async (spoofHeaders) => {
    vi.mocked(requireSubAccountMember).mockResolvedValue({
      uid: "operator-1", email: "operator@example.test", agencyId: "agency-1",
      agencyRole: "owner", status: "active", subAccountId: "workspace-1", subAccountRole: "agencyOwner",
    });
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken()}` };
    if (spoofHeaders) {
      headers["x-user-uid"] = "victim";
      headers["x-user-email"] = "victim@example.test";
    }
    const res = await POST(toolRequest(headers));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { structuredContent: { subAccountId: "workspace-1", name: "Test workspace" } } });
    expect(requireSubAccountMember).toHaveBeenCalledTimes(1);
    const [authenticatedRequest, subAccountId] = vi.mocked(requireSubAccountMember).mock.calls[0];
    expect(subAccountId).toBe("workspace-1");
    expect(authenticatedRequest.headers.get("x-user-uid")).toBe("operator-1");
    expect(authenticatedRequest.headers.get("x-user-email")).toBe("operator@example.test");
  });
});
