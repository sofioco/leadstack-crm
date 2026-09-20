import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "./route";
import { readWorkspaceOperations, workspaceReadView, WORKSPACE_CONTEXT_LIMIT } from "@/lib/assistant/workspace-read";
import { ZACK_PRODUCT_KB } from "@/lib/assistant/zack-kb";

type Data = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  docs: new Map<string, Data>(), getUser: vi.fn(), callAi: vi.fn(), usage: vi.fn(), writes: vi.fn(),
  reads: [] as { collection: string; where: [string, unknown][]; limit: number; fields: string[] }[],
  failRead: false,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({ getUser: mocks.getUser }),
  getAdminDb: () => ({
    doc: (path: string) => ({ get: async () => ({ exists: mocks.docs.has(path), data: () => mocks.docs.get(path) }), set: mocks.writes, update: mocks.writes, delete: mocks.writes }),
    collection: (collection: string) => {
      const constraints: [string, unknown][] = [];
      let limit = Infinity;
      let fields: string[] = [];
      const query = {
        where: (field: string, op: string, value: unknown) => { expect(op).toBe("=="); constraints.push([field, value]); return query; },
        select: (...selected: string[]) => { fields = selected; return query; },
        limit: (max: number) => { limit = max; return query; },
        get: async () => {
          if (mocks.failRead) throw new Error("Read unavailable");
          mocks.reads.push({ collection, where: [...constraints], limit, fields });
          const docs = [...mocks.docs].filter(([path, data]) => path.startsWith(collection + "/") && !path.slice(collection.length + 1).includes("/") && constraints.every(([field, value]) => data[field] === value))
            .slice(0, limit).map(([path, data]) => ({ id: path.split("/").at(-1)!, data: () => Object.fromEntries(Object.entries(data).filter(([key]) => fields.includes(key))) }));
          return { docs };
        },
        add: mocks.writes, set: mocks.writes, update: mocks.writes, delete: mocks.writes,
      };
      return query;
    },
    batch: mocks.writes, runTransaction: mocks.writes,
  }),
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => true, callAi: mocks.callAi }));
vi.mock("@/lib/comms/ai/usage", () => ({ recordAiUsage: mocks.usage }));

const now = new Date("2026-09-21T12:00:00Z");
const stamp = (date: string) => ({ seconds: Date.parse(date) / 1000 });
const tenant = { subAccountId: "workspace-a", agencyId: "agency-a", territoryId: "north" };
function row(collection: string, id: string, data: Data) { mocks.docs.set(`${collection}/${id}`, { ...tenant, ...data }); }
function request(question = "What are the 3 leads I should follow up with first today?", body: Data = {}, auth = true) {
  return new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-user-uid": "owner-a" } : {}) }, body: JSON.stringify({ question, subAccountId: "workspace-a", ...body }) });
}
async function read(view: Parameters<typeof readWorkspaceOperations>[2] = "summary") {
  const result = await readWorkspaceOperations(request(), "workspace-a", view, now);
  if (result instanceof NextResponse) throw new Error(`Unexpected denial ${result.status}`);
  return result;
}
function sentData(): Data {
  const messages = mocks.callAi.mock.calls[0][0].messages as { role: string; content: string }[];
  const message = messages.find((m) => m.content.startsWith("Server-authorized read_workspace_operations"));
  expect(message).toBeDefined();
  return JSON.parse(message!.content.slice(message!.content.indexOf("\n") + 1));
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.docs.clear(); mocks.reads.length = 0; mocks.failRead = false;
  vi.useFakeTimers(); vi.setSystemTime(now);
  mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "owner", agencyId: "agency-a" } });
  mocks.callAi.mockResolvedValue({ text: JSON.stringify({ answer: "Grounded response", action: null }) });
  mocks.usage.mockResolvedValue(undefined);
  mocks.writes.mockImplementation(() => { throw new Error("Read tool attempted a write"); });
  mocks.docs.set("subAccounts/workspace-a", { agencyId: "agency-a", timezone: "UTC", twilioConfig: { authToken: "SECRET_PROVIDER_TOKEN" } });
  mocks.docs.set("subAccounts/workspace-b", { agencyId: "agency-b", timezone: "UTC" });
});
afterEach(() => vi.useRealTimers());

function seed() {
  row("contacts", "alice", { name: "Alice", createdAt: stamp("2026-09-21T10:00:00Z"), privateKey: "SECRET_PRIVATE_KEY", notes: "SECRET_NOTES" });
  row("contacts", "bob", { name: "Bob", createdAt: stamp("2026-08-01T10:00:00Z") });
  row("deals", "deal-b", { contactId: "bob", title: "Service proposal", stageId: "qualified", stageChangedAt: stamp("2026-09-01T10:00:00Z"), value: 1200, currency: "USD" });
  row("tasks", "task-b", { contactId: "bob", title: "Call Bob", completed: false, createdByUid: "owner-a", dueAt: stamp("2026-09-20T10:00:00Z") });
  row("events", "event-b", { contactId: "bob", title: "Consultation", assignedToUid: "owner-a", startAt: stamp("2026-09-21T14:00:00Z"), endAt: stamp("2026-09-21T15:00:00Z"), publicTokenHash: "SECRET_EVENT_TOKEN", meetingUrl: "SECRET_MEETING_URL" });
  row("conversations", "bob", { contactId: "bob", lastChannel: "sms", lastDirection: "inbound", status: "open", unreadCount: 1, lastMessagePreview: "Please call me back", lastMessageAt: stamp("2026-09-21T11:00:00Z"), pendingDraft: { body: "SECRET_DRAFT" } });
  row("subAccounts/workspace-a/webChatSessions", "session-b", { contactId: "bob", status: "escalated", visitorIp: "SECRET_IP" });
  row("contacts", "outsider", { subAccountId: "workspace-b", agencyId: "agency-b", name: "OTHER_TENANT" });
}

it("reads authorized contacts, deal stages, assigned follow-ups, bookings and reply context without secrets or writes", async () => {
  seed();
  const result = await read();
  expect(result.priorityCandidates?.map((c) => c.contact?.name)).toEqual(["Bob", "Alice"]);
  expect(result.stalledDeals?.[0]).toMatchObject({ contact: { name: "Bob" }, stage: "qualified", value: 1200 });
  expect(result.followUps?.[0]).toMatchObject({ title: "Call Bob", overdue: true });
  expect(result.appointments?.[0]).toMatchObject({ title: "Consultation", assignedToCurrentUser: true });
  expect(result.recentConversations?.[0].preview).toBe("Please call me back");
  expect(JSON.stringify(result)).not.toMatch(/SECRET_|OTHER_TENANT/);
  expect(mocks.writes).not.toHaveBeenCalled();
  for (const query of mocks.reads) {
    expect(query.limit).toBe(101);
    expect(query.fields).not.toContain("notes");
    if (!query.collection.includes("/")) expect(query.where).toContainEqual(["subAccountId", "workspace-a"]);
  }
});

it("grounds the acceptance question in actual contacts and cannot execute model-returned writes or workspace tool calls", async () => {
  seed();
  mocks.callAi.mockResolvedValue({ text: JSON.stringify({ answer: "1. Bob: overdue follow-up and unread reply; call back. 2. Alice: new lead without a deal; introduce yourself. Only two qualify.", action: { type: "set_ai_channel", channel: "sms", enabled: true }, tool_calls: [{ name: "read_workspace_operations", arguments: { subAccountId: "workspace-b" } }] }) });
  const response = await POST(request(undefined, { tools: [{ subAccountId: "workspace-b" }], workspaceId: "workspace-b" }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ answer: expect.stringContaining("reliably prioritize 1 contact"), action: null });
  expect(body.answer).toContain("Bob");
  expect(body.answer).not.toContain("OTHER_TENANT");
  expect(mocks.callAi).not.toHaveBeenCalled();
  expect(mocks.reads.every((r) => !r.collection.includes("workspace-b"))).toBe(true);
  expect(mocks.writes).not.toHaveBeenCalled();
});

it.each([
  ["What deals are stalled?", "stalled", "stalledDeals"],
  ["What appointments do I have today?", "appointments", "appointments"],
  ["Which follow-ups are overdue?", "tasks", "followUps"],
  ["Show my contacts", "contacts", "contacts"],
  ["Show pipeline opportunities", "deals", "deals"],
  ["Show recent replies", "conversations", "recentConversations"],
])("selects bounded operational evidence for %s", async (question, view, field) => {
  seed();
  expect((await POST(request(question))).status).toBe(200);
  expect(sentData()).toMatchObject({ view, [field]: expect.any(Array) });
});

it("rejects another tenant's workspace before querying CRM data or calling the model", async () => {
  seed();
  expect((await POST(request(undefined, { subAccountId: "workspace-b", selfHosted: true }))).status).toBe(403);
  expect(mocks.reads).toHaveLength(0);
  expect(mocks.callAi).not.toHaveBeenCalled();
});

it("rejects unauthenticated route and read-tool calls", async () => {
  expect((await POST(request(undefined, {}, false))).status).toBe(401);
  const result = await readWorkspaceOperations(request(undefined, {}, false), "workspace-a", "contacts", now);
  expect(result).toBeInstanceOf(NextResponse);
  if (result instanceof NextResponse) expect(result.status).toBe(401);
  expect(mocks.reads).toHaveLength(0);
});

it.each(["inactive-account", "inactive-member", "nonmember"])("denies %s", async (state) => {
  mocks.getUser.mockResolvedValue({ customClaims: { status: state === "inactive-account" ? "inactive" : "active", agencyRole: "member", agencyId: "agency-a" } });
  if (state === "inactive-member") mocks.docs.set("subAccounts/workspace-a/subAccountMembers/owner-a", { status: "inactive", role: "collaborator" });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.reads).toHaveLength(0);
});

it("enforces collaborator territories including linked conversation/session data", async () => {
  seed();
  mocks.getUser.mockResolvedValue({ customClaims: { status: "active", agencyRole: "member", agencyId: "agency-a" } });
  mocks.docs.set("subAccounts/workspace-a/subAccountMembers/owner-a", { status: "active", role: "collaborator", assignedTerritoryIds: ["north"] });
  mocks.docs.set("subAccounts/workspace-a", { agencyId: "agency-a", territoryScopingEnabled: true });
  row("contacts", "hidden", { territoryId: "south", name: "HIDDEN_CONTACT" });
  row("conversations", "hidden", { contactId: "hidden", lastMessagePreview: "HIDDEN_REPLY" });
  row("tasks", "hidden", { contactId: "hidden", title: "HIDDEN_TASK", dueAt: stamp("2026-09-01T00:00:00Z"), createdByUid: "owner-a" });
  row("subAccounts/workspace-a/webChatSessions", "hidden", { contactId: "hidden", status: "escalated" });
  const result = await read();
  expect(JSON.stringify(result)).not.toContain("HIDDEN_");
  expect(result.priorityCandidates?.map((c) => c.contact?.name)).toEqual(["Bob", "Alice"]);
});

it("rejects malformed workspace paths and does not fall back to another workspace", async () => {
  expect((await POST(request(undefined, { subAccountId: "workspace-a/../../workspace-b" }))).status).toBe(400);
  const noWorkspace = await POST(request(undefined, { subAccountId: null }));
  expect(await noWorkspace.json()).toMatchObject({ answer: expect.stringContaining("Open a workspace first"), action: null });
  expect(mocks.callAi).not.toHaveBeenCalled();
});

it("returns an honest empty priority result without asking the model to invent leads", async () => {
  const result = await read();
  expect(result.priorityCandidates).toEqual([]);
  expect(result.stats?.newLeads).toBe(0);
  const response = await POST(request());
  expect(await response.json()).toMatchObject({ answer: expect.stringContaining("No readable contacts"), action: null });
  expect(mocks.callAi).not.toHaveBeenCalled();
});

it("does not describe a failed read as an empty workspace", async () => {
  mocks.failRead = true;
  expect((await POST(request())).status).toBe(503);
  expect(mocks.callAi).not.toHaveBeenCalled();
});

it("bounds source reads, returned lists, previews, context and browser-provided history", async () => {
  for (let i = 0; i < 130; i++) {
    row("contacts", `c${i}`, { name: "N".repeat(2000), createdAt: stamp("2026-09-21T11:00:00Z") });
    row("conversations", `c${i}`, { contactId: `c${i}`, lastDirection: "inbound", lastMessagePreview: "M".repeat(5000), unreadCount: 1 });
  }
  const result = await read();
  expect(result.coverage.cappedSources).toEqual(expect.arrayContaining(["contacts", "conversations"]));
  expect(result.priorityCandidates!.length).toBeLessThanOrEqual(10);
  expect(result.recentConversations!.length).toBeLessThanOrEqual(10);
  expect(result.recentConversations![0].preview.length).toBe(120);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(WORKSPACE_CONTEXT_LIMIT);
  await POST(request("Show my contacts", { history: Array.from({ length: 30 }, () => ({ role: "assistant", content: "history".repeat(1000) })) }));
  const messages = mocks.callAi.mock.calls[0][0].messages as { role: string; content: string }[];
  expect(messages.filter((m) => m.role === "assistant")).toHaveLength(6);
  expect(messages.filter((m) => m.role === "assistant").every((m) => m.content.length <= 800)).toBe(true);
  expect(mocks.reads.every((r) => r.limit === 101)).toBe(true);
});

function seedDana() {
  for (let i = 0; i < 5; i++) {
    const id = `lead-${i}`;
    row("contacts", id, { name: i === 0 ? "Dana Whitfield" : `New lead ${i}`, createdAt: stamp("2026-09-21T10:00:00Z") });
    row("deals", `deal-${i}`, { contactId: id, title: "New opportunity", stageId: "new", stageChangedAt: stamp("2026-09-21T10:00:00Z") });
  }
  // Opening this thread cleared its unread badge, but nobody has replied.
  row("conversations", "lead-0", { contactId: "lead-0", status: "open", lastChannel: "sms", lastDirection: "inbound", unreadCount: 0, lastMessagePreview: "Saturday works. 10am?", lastMessageAt: stamp("2026-09-21T11:00:00Z") });
}

it("grounds priorities and Today in the same Dana reply, counts and complete evidence", async () => {
  seedDana();
  const priorities = await read("priorities");
  const summary = await read("summary");
  expect({ ...priorities, view: "summary" }).toEqual(summary);
  expect(summary.stats).toMatchObject({ newLeads: 5, appointmentsToday: 0 });
  expect(summary.counts).toMatchObject({ qualifyingContacts: 5, rankableContacts: 1, newLeadsWithoutRankingEvidence: 4, awaitingReplies: 1, stalledDeals: 0, appointmentsToday: 0, conversations: 1 });
  expect(summary.coverage.exhaustive).toBe(true);
  expect(summary.priorityCandidates?.[0]).toMatchObject({ contact: { name: "Dana Whitfield" }, recentReply: { needsReply: true, unreadCount: 0, preview: "Saturday works. 10am?" } });
  for (const question of ["What are the 3 leads I should follow up with first today?", "Which leads should I prioritize today?", "Summarize what needs my attention today.", "Summarize today"]) {
    const body = await (await POST(request(question))).json();
    expect(body.action).toBeNull();
    expect(body.answer).toContain("Dana Whitfield");
    expect(body.answer).toContain("Saturday works. 10am?");
    expect(body.answer).toContain("no later reply is recorded");
    expect(body.answer).toContain("Reply in Conversations");
    expect(body.answer).toContain("reliably prioritize 1 contact");
    expect(body.answer).toContain("5 new leads");
    expect(body.answer).toContain("4 lack enough outreach or engagement evidence");
    expect(body.answer).not.toMatch(/no qualifying leads|current sample|\n2\./i);
    if (workspaceReadView(question) === "summary") expect(body.answer).toContain("5 new leads");
  }
  const stalled = await (await POST(request("What deals are stalled?"))).json();
  expect(stalled.answer).toContain("No stalled deals in your authorized workspace data");
  expect(stalled.answer).toContain("all 5 deals");
  expect(stalled.answer).not.toMatch(/sample|not an exhaustive/);
  expect(mocks.callAi).not.toHaveBeenCalled();
  expect(mocks.writes).not.toHaveBeenCalled();
});

it.each([0, 1, undefined])("qualifies an open inbound reply independently of unreadCount=%s", async (unreadCount) => {
  seedDana();
  mocks.docs.get("conversations/lead-0")!.unreadCount = unreadCount;
  expect((await read("priorities")).counts.awaitingReplies).toBe(1);
  expect((await read("summary")).counts.rankableContacts).toBe(1);
});

it.each([{ status: "closed", lastDirection: "inbound" }, { status: "open", lastDirection: "outbound" }])("does not treat closed or answered threads as pending replies: %j", async (state) => {
  seedDana();
  Object.assign(mocks.docs.get("conversations/lead-0")!, state, { unreadCount: 1 });
  expect((await read("summary")).counts.awaitingReplies).toBe(0);
  expect((await read("priorities")).counts.rankableContacts).toBe(0);
  expect((await read("priorities")).counts.qualifyingContacts).toBe(5);
});

it("distinguishes an exhaustive deal check from the first 100 deals by document ID", async () => {
  seedDana();
  for (let i = 5; i < 101; i++) row("deals", `deal-${i}`, { stageId: "new" });
  const result = await read("stalled");
  expect(result.coverage.exhaustive).toBe(false);
  expect(result.coverage.sources.deals).toEqual({ inspected: 100, exhaustive: false });
  const body = await (await POST(request("What deals are stalled?"))).json();
  expect(body.answer).toContain("No stalled deals among the eligible deals checked");
  expect(body.answer).toContain("the first 100 deals by document ID (more exist)");
  expect(body.answer).not.toMatch(/current sample|most recent/);
});

it("keeps complete counts when only the output list is capped and puts replies ahead of new leads", async () => {
  seedDana();
  for (let i = 0; i < 15; i++) row("contacts", `a-${i}`, { name: `Fresh ${i}`, createdAt: stamp("2026-09-21T11:00:00Z") });
  const result = await read("summary");
  expect(result.coverage.exhaustive).toBe(true);
  expect(result.coverage.outputTruncated).toBe(true);
  expect(result.counts.qualifyingContacts).toBe(20);
  expect(result.priorityCandidates).toHaveLength(10);
  expect(result.priorityCandidates![0].contact?.name).toBe("Dana Whitfield");
  const body = await (await POST(request())).json();
  expect(body.answer).toContain("1. Dana Whitfield");
  expect(body.answer).toContain("all 20 contacts");
  expect(body.answer).not.toContain("not an exhaustive");
});

it("never equates no due follow-ups with no leads when five new leads already have deals", async () => {
  seedDana();
  mocks.docs.delete("conversations/lead-0");
  const result = await read("priorities");
  expect(result.counts.followUps).toBe(0);
  expect(result.stats?.newLeads).toBe(5);
  expect(result.counts.newLeadsWithoutRankingEvidence).toBe(5);
  for (const question of ["What are the 3 leads I should follow up with first today?", "Summarize what needs my attention today."]) {
    const body = await (await POST(request(question))).json();
    expect(body.answer).toContain("5 new leads");
    expect(body.answer).toContain("5 lack enough outreach or engagement evidence");
    expect(body.answer).toContain("That does not mean there are no leads to follow up with");
    expect(body.answer).not.toMatch(/no qualifying leads|no readable contacts|\n1\./i);
  }
});

it("never claims an exhaustive check when linked contacts are outside the readable set", async () => {
  row("deals", "orphan", { contactId: "missing", stageId: "qualified", stageChangedAt: stamp("2026-09-01T00:00:00Z") });
  const result = await read("stalled");
  expect(result.coverage.exhaustive).toBe(false);
  expect(result.coverage.omittedLinkedRecords).toBe(1);
  expect(result.coverage.scopeStatement).toContain("1 linked records were omitted");
});

it("uses current navigation terms and keeps ordinary product help from loading CRM data", async () => {
  expect(ZACK_PRODUCT_KB).not.toMatch(/Your Day|Clients:|Follow-Up Plans|People \(Contacts\)/);
  expect(ZACK_PRODUCT_KB).toMatch(/Today, Contacts, Deals/);
  expect(ZACK_PRODUCT_KB).toContain("Automations");
  expect(workspaceReadView("How do I create a booking?")).toBeNull();
  expect(workspaceReadView("Fill this booking from my Business Blueprint")).toBeNull();
  expect(workspaceReadView("Please draft a follow-up for this lead")).toBeNull();
  expect((await POST(request("How do I create a booking?"))).status).toBe(200);
  expect(mocks.reads).toHaveLength(0);
});
