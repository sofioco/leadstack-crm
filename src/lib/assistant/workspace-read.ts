import "server-only";

import { NextResponse } from "next/server";
import type { Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { computeBriefingStats, toMillis } from "@/lib/briefing/compute";
import { localTimeInfo } from "@/lib/briefing/local-time";
import { isAssignedFollowUp, isNewLead, isStalledDeal, needsConversationReply } from "@/lib/dashboard/priority-signals";
import { getStage, resolvePipelineStages } from "@/types/deals";

export type WorkspaceReadView = "priorities" | "summary" | "contacts" | "deals" | "stalled" | "tasks" | "appointments" | "conversations";
export const WORKSPACE_READ_LIMIT = 100;
export const WORKSPACE_RESULT_LIMIT = 10;
export const WORKSPACE_CONTEXT_LIMIT = 24_000;
const TEXT_LIMIT = 120;

/** Server-selected aggregate, not model-generated queries or tool arguments. */
export function workspaceReadView(question: string): WorkspaceReadView | null {
  if (/^(?:(?:please|can you|help me)\s+)?(?:open|navigate|go to|fill|populate|enable|disable|turn on|turn off|set|draft|write|create|how (?:do|can|to)|where (?:is|do))\b/i.test(question.trim())) return null;
  if (/stalled|stuck deals/i.test(question)) return "stalled";
  if (/overdue|follow[- ]?ups? (?:are )?due/i.test(question)) return "tasks";
  if (/appointments?|bookings?|calendar/i.test(question)) return "appointments";
  if (/priorit|follow up.*(?:first|today)|(?:first|top|3|three).*leads?/i.test(question)) return "priorities";
  if (/attention|summari[sz]e.*today|today.*summar/i.test(question)) return "summary";
  if (/conversations?|replies|inbox|recent messages/i.test(question)) return "conversations";
  if (/deals?|opportunities|pipeline/i.test(question)) return "deals";
  if (/contacts?|leads?/i.test(question)) return "contacts";
  if (/tasks?|follow[- ]?ups?/i.test(question)) return "tasks";
  return null;
}

type Row = Record<string, unknown> & { id: string; status?: unknown; lastDirection?: unknown };
function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "";
}
function iso(value: unknown): string | null {
  const ms = toMillis(value);
  return ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function taskLike(row: Row) {
  return { completed: row.completed === true, assignedToUid: typeof row.assignedToUid === "string" ? row.assignedToUid : null, createdByUid: text(row.createdByUid), dueAt: row.dueAt };
}
function dealLike(row: Row) {
  return { stageId: text(row.stageId), stageChangedAt: row.stageChangedAt };
}

/** Read-only. Re-authorizes the selected workspace; no caller supplies queries or paths. */
export async function readWorkspaceOperations(request: Request, subAccountId: string, view: WorkspaceReadView, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subAccountId)) {
    return NextResponse.json({ error: "Invalid workspace." }, { status: 400 });
  }
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const authorizedWorkspaceId = access.subAccountId;
  const db = getAdminDb();
  const workspace = await db.doc(`subAccounts/${access.subAccountId}`).get();
  const agencyId = workspace.data()?.agencyId;
  if (!workspace.exists || typeof agencyId !== "string") {
    return NextResponse.json({ error: "Workspace unavailable." }, { status: 403 });
  }
  const territory = await loadEffectiveTerritoryScope(access);
  const stages = resolvePipelineStages(workspace.data()?.pipelineStages);
  let timezone = text(workspace.data()?.timezone) || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(now); } catch { timezone = "UTC"; }
  const day = localTimeInfo(timezone, now);
  const nowMs = now.getTime();
  const cappedSources: string[] = [];
  const sources: Record<string, { inspected: number; exhaustive: boolean }> = {};
  let omittedLinkedRecords = 0;
  let omittedTenantRecords = 0;

  // Equality + fixed limit needs no new composite indexes. The extra row
  // detects truncation. Never represent a bounded sample as a complete list.
  async function read(collection: string): Promise<Row[]> {
    let query: Query = db.collection(collection);
    if (!collection.includes("/")) query = query.where("subAccountId", "==", authorizedWorkspaceId);
    const snap = await query.select(
      "agencyId", "subAccountId", "territoryId", "contactId", "name", "source", "createdAt",
      "title", "stageId", "stageChangedAt", "value", "currency", "completed", "assignedToUid", "createdByUid", "dueAt",
      "startAt", "endAt", "status", "lastChannel", "lastDirection", "lastMessagePreview", "lastMessageAt", "unreadCount",
    ).limit(WORKSPACE_READ_LIMIT + 1).get();
    const source = collection.split("/").at(-1)!;
    if (snap.docs.length > WORKSPACE_READ_LIMIT) cappedSources.push(source);
    const inspected = snap.docs.slice(0, WORKSPACE_READ_LIMIT);
    sources[source] = { inspected: inspected.length, exhaustive: snap.docs.length <= WORKSPACE_READ_LIMIT };
    return inspected.map((doc): Row => ({ ...doc.data(), id: doc.id }))
      .filter((row) => {
        const allowed = row.subAccountId === authorizedWorkspaceId && row.agencyId === agencyId;
        if (!allowed) omittedTenantRecords++;
        return allowed;
      });
  }
  const scoped = (row: Row) => !territory.enforce || (typeof row.territoryId === "string" && territory.ids?.includes(row.territoryId));
  const contacts = (await read("contacts")).filter(scoped);
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const linkedVisible = (row: Row) => {
    const allowed = !row.contactId || (typeof row.contactId === "string" && contactById.has(row.contactId));
    if (!allowed) omittedLinkedRecords++;
    return allowed;
  };
  const needsAll = view === "priorities" || view === "summary";
  const deals = (needsAll || view === "deals" || view === "stalled" ? await read("deals") : []).filter(scoped).filter(linkedVisible);
  const tasks = (needsAll || view === "tasks" ? await read("tasks") : []).filter(scoped).filter(linkedVisible);
  const events = (needsAll || view === "appointments" ? await read("events") : []).filter(scoped).filter(linkedVisible);
  const conversations = (needsAll || view === "conversations" ? await read("conversations") : [])
    .filter((row) => {
      if (!row.contactId) { omittedLinkedRecords++; return false; }
      return linkedVisible(row);
    })
    .sort((a, b) => (toMillis(b.lastMessageAt) ?? 0) - (toMillis(a.lastMessageAt) ?? 0));
  const sessions = (needsAll || view === "conversations" ? await read(`subAccounts/${access.subAccountId}/webChatSessions`) : [])
    .filter((row) => row.contactId ? linkedVisible(row) : !territory.enforce);
  const followUps = tasks.filter((row) => isAssignedFollowUp(taskLike(row), access.uid, day.dayEndMs))
    .sort((a, b) => (toMillis(a.dueAt) ?? 0) - (toMillis(b.dueAt) ?? 0));
  const stalled = deals.filter((row) => isStalledDeal(dealLike(row), nowMs))
    .sort((a, b) => (toMillis(a.stageChangedAt) ?? 0) - (toMillis(b.stageChangedAt) ?? 0));
  const appointments = events.filter((row) => {
    const start = toMillis(row.startAt);
    return row.status !== "cancelled" && start !== null && start >= day.dayStartMs && start < day.dayEndMs;
  }).sort((a, b) => (toMillis(a.startAt) ?? 0) - (toMillis(b.startAt) ?? 0));
  const contact = (id: unknown) => typeof id === "string" && contactById.has(id)
    ? { id, name: text(contactById.get(id)?.name) || "Unnamed contact" } : null;
  const deal = (row: Row) => ({ id: row.id, title: text(row.title), contact: contact(row.contactId), stage: text(row.stageId), stageLabel: text(getStage(text(row.stageId), stages).label), value: number(row.value), currency: text(row.currency), stageChangedAt: iso(row.stageChangedAt) });
  const task = (row: Row) => ({ id: row.id, title: text(row.title), contact: contact(row.contactId), dueAt: iso(row.dueAt), overdue: (toMillis(row.dueAt) ?? Infinity) < day.dayStartMs });
  const appointment = (row: Row) => ({ id: row.id, title: text(row.title), contact: contact(row.contactId), startAt: iso(row.startAt), endAt: iso(row.endAt), status: text(row.status) || "scheduled", assignedToCurrentUser: row.assignedToUid === access.uid, hostUnassigned: !row.assignedToUid });
  const conversation = (row: Row) => ({ contact: contact(row.contactId), channel: text(row.lastChannel), direction: text(row.lastDirection), preview: text(row.lastMessagePreview), lastMessageAt: iso(row.lastMessageAt), unreadCount: number(row.unreadCount), status: text(row.status), needsReply: needsConversationReply(row) });

  const candidates = contacts.map((row) => {
    const linkedDeals = deals.filter((d) => d.contactId === row.id);
    const linkedTasks = followUps.filter((t) => t.contactId === row.id);
    const linkedConversations = conversations.filter((c) => c.contactId === row.id);
    const pendingReply = linkedConversations.find(needsConversationReply);
    const reasons: string[] = [];
    const escalated = sessions.some((s) => s.contactId === row.id && s.status === "escalated");
    const newLead = isNewLead({ createdAt: row.createdAt }, nowMs);
    const newWithoutDeal = newLead && linkedDeals.length === 0 && !cappedSources.includes("deals");
    const stalledOpportunity = stalled.some((d) => d.contactId === row.id);
    if (escalated) reasons.push("Web chat needs a human reply");
    if (pendingReply) reasons.push("Open conversation's latest message is inbound; no later reply is recorded");
    if (newWithoutDeal) reasons.push("New in the last 24 hours; no visible deal yet");
    else if (newLead) reasons.push("New in the last 24 hours; outreach status is not established by creation time");
    if (linkedTasks.length) reasons.push("Your assigned follow-up is due by today");
    if (stalledOpportunity) reasons.push("Open deal unchanged for at least 7 days");
    // Order existing signals categorically, without inventing a lead score.
    // Creation time alone cannot prove whether a lead has been contacted.
    const priority = escalated || pendingReply ? 1 : linkedTasks.length ? 2 : stalledOpportunity ? 3 : 4;
    const rankingSupported = priority < 4;
    const suggestedNextAction = pendingReply ? "Reply in Conversations." : escalated ? "Review and reply to the escalated web chat." : linkedTasks.length ? "Complete the assigned follow-up." : stalledOpportunity ? "Review the deal and follow up on its next step." : "Review the contact's outreach history before choosing the next follow-up.";
    return { contact: contact(row.id), reasons, priority, rankingSupported, suggestedNextAction, deals: linkedDeals.slice(0, 3).map(deal), followUps: linkedTasks.slice(0, 3).map(task), recentReply: pendingReply ? conversation(pendingReply) : linkedConversations[0] ? conversation(linkedConversations[0]) : null };
  }).filter((item) => item.reasons.length > 0).sort((a, b) => a.priority - b.priority || (a.contact?.id ?? "").localeCompare(b.contact?.id ?? ""));

  const stats = needsAll ? computeBriefingStats({
    contacts: contacts.map((row) => ({ createdAt: row.createdAt })),
    tasks: tasks.filter((row) => (row.assignedToUid ?? row.createdByUid) === access.uid).map(taskLike),
    deals: deals.map((row) => ({ ...dealLike(row), value: number(row.value) ?? 0 })),
    events: events.filter((row) => row.status !== "cancelled").map((row) => ({ startAt: row.startAt })),
    sessions: sessions.map((row) => ({ status: text(row.status) })),
    todayStartMs: day.dayStartMs, todayEndMs: day.dayEndMs, now,
  }) : undefined;

  const result = {
    tool: "read_workspace_operations", view, asOf: now.toISOString(), timezone, date: day.dateKey,
    scope: "Authorized workspace and permitted territories. Follow-ups are assigned to the current user. Appointments include the workspace calendar with assignment indicated, not necessarily only the user's appointments.",
    coverage: { sources, exhaustive: cappedSources.length === 0 && omittedLinkedRecords === 0 && omittedTenantRecords === 0, omittedLinkedRecords, cappedSources, maxDocumentsPerSource: WORKSPACE_READ_LIMIT, maxResultsPerList: WORKSPACE_RESULT_LIMIT, candidatesOmitted: Math.max(0, candidates.length - WORKSPACE_RESULT_LIMIT), outputTruncated: false, scopeStatement: "", note: "Source reads are in document-ID ascending order, NOT most-recent order. Counts are computed before output list limits. Linked records without a readable contact are excluded. No message history is loaded; previews are at most 120 characters." },
    ...(needsAll ? { stats, priorityCandidates: candidates.slice(0, WORKSPACE_RESULT_LIMIT) } : {}),
    counts: { qualifyingContacts: candidates.length, rankableContacts: candidates.filter((candidate) => candidate.rankingSupported).length, newLeadsWithoutRankingEvidence: candidates.filter((candidate) => !candidate.rankingSupported).length, contacts: contacts.length, stalledDeals: stalled.length, followUps: followUps.length, appointmentsToday: appointments.length, conversations: conversations.length, awaitingReplies: conversations.filter(needsConversationReply).length },
    ...(view === "contacts" ? { contacts: contacts.slice(0, WORKSPACE_RESULT_LIMIT).map((row) => ({ ...contact(row.id), source: text(row.source), createdAt: iso(row.createdAt) })) } : {}),
    ...(view === "deals" ? { deals: deals.slice(0, WORKSPACE_RESULT_LIMIT).map(deal) } : {}),
    ...(view === "stalled" || needsAll ? { stalledDeals: stalled.slice(0, WORKSPACE_RESULT_LIMIT).map(deal) } : {}),
    ...(view === "tasks" || needsAll ? { followUps: followUps.slice(0, WORKSPACE_RESULT_LIMIT).map(task) } : {}),
    ...(view === "appointments" || needsAll ? { appointments: appointments.slice(0, WORKSPACE_RESULT_LIMIT).map(appointment) } : {}),
    ...(view === "conversations" || needsAll ? { recentConversations: conversations.slice(0, WORKSPACE_RESULT_LIMIT).map(conversation), escalatedWebChats: sessions.filter((row) => row.status === "escalated").slice(0, WORKSPACE_RESULT_LIMIT).map((row) => ({ id: row.id, contact: contact(row.contactId), status: "escalated" })) } : {}),
  };
  const labels: Record<string, string> = { events: "appointments", webChatSessions: "web chats" };
  result.coverage.scopeStatement = "I checked " + Object.entries(sources).map(([name, source]) => source.exhaustive
    ? `all ${source.inspected} ${labels[name] ?? name}`
    : `the first ${source.inspected} ${labels[name] ?? name} by document ID (more exist)`
  ).join(", ") + ". Results include only your permitted territories and readable contact links.";
  if (!result.coverage.exhaustive) result.coverage.scopeStatement += " This is not an exhaustive workspace check; counts and findings apply only to the eligible records checked.";
  if (omittedLinkedRecords) result.coverage.scopeStatement += ` ${omittedLinkedRecords} linked records were omitted because their contacts were not in the readable contact set.`;
  const lists: unknown[][] = [];
  for (const value of Object.values(result)) if (Array.isArray(value)) lists.push(value);
  result.coverage.outputTruncated = [contacts, deals, followUps, stalled, appointments, conversations, sessions, candidates].some((rows) => rows.length > WORKSPACE_RESULT_LIMIT);
  while (JSON.stringify(result).length > WORKSPACE_CONTEXT_LIMIT) {
    const largest = lists.filter((list) => list.length).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!largest) throw new Error("Workspace read exceeds context budget");
    largest.pop();
    result.coverage.outputTruncated = true;
  }
  return result;
}

type WorkspaceOperations = Exclude<Awaited<ReturnType<typeof readWorkspaceOperations>>, NextResponse>;

/** Format shared facts, rather than asking the model to independently reclassify them. */
export function groundedWorkspaceAnswer(result: WorkspaceOperations): string | null {
  const scope = result.coverage.scopeStatement;
  if (result.view === "stalled" && result.counts.stalledDeals === 0) {
    return `No stalled deals ${result.coverage.exhaustive ? "in your authorized workspace data" : "among the eligible deals checked"}.\n\n${scope}`;
  }
  if (result.view !== "priorities" && result.view !== "summary") return null;
  const plain = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, "\\$&");
  const entries = (result.priorityCandidates ?? []).filter((candidate) => candidate.rankingSupported).slice(0, 3).map((candidate, index) => {
    const reply = candidate.recentReply?.needsReply ? ` ${plain(candidate.recentReply.channel.toUpperCase())}: "${plain(candidate.recentReply.preview)}"` : "";
    const task = candidate.followUps[0] ? ` Follow-up: ${plain(candidate.followUps[0].title)} (${candidate.followUps[0].overdue ? "overdue" : "due today"}).` : "";
    const deal = candidate.deals[0] ? ` Deal: ${plain(candidate.deals[0].title)} (${plain(candidate.deals[0].stageLabel)}).` : "";
    return `${index + 1}. ${plain(candidate.contact?.name ?? "Unnamed contact")}: ${candidate.reasons.join("; ")}.${reply}${task}${deal} Next: ${candidate.suggestedNextAction}`;
  });
  const qualifier = result.counts.rankableContacts < 3 ? `I can reliably prioritize ${result.counts.rankableContacts} ${result.counts.rankableContacts === 1 ? "contact" : "contacts"} from the available signals.` : "Follow up with these contacts first:";
  const priorityText = entries.length ? `${qualifier}\n${entries.join("\n")}` : result.counts.rankableContacts > 0
    ? `I found ${result.counts.rankableContacts} contacts with priority signals, but their details exceeded the response limit. Review Today or Contacts.`
    : result.counts.contacts === 0 ? "No readable contacts were found in the records checked."
    : "There are contacts in the workspace, but no outstanding reply, assigned follow-up due by today, or stalled deal in the eligible records checked. That does not mean there are no leads to follow up with.";
  const uncertainty = result.counts.newLeadsWithoutRankingEvidence > 0
    ? `\n\n${result.stats?.newLeads ?? 0} new leads were created in the last 24 hours; ${result.counts.newLeadsWithoutRankingEvidence} lack enough outreach or engagement evidence to reliably rank against each other. Creation time or an existing deal does not establish whether they have been contacted. Review these new leads in Contacts; I won't invent a top three.` : "";
  const summary = result.view === "summary" ? `${result.stats?.newLeads ?? 0} new leads in the last 24 hours; ${result.counts.conversations} conversations checked, ${result.counts.awaitingReplies} awaiting replies; ${result.counts.stalledDeals} stalled deals; ${result.counts.appointmentsToday} appointments today; ${result.stats?.tasksOverdue ?? 0} overdue follow-ups and ${result.stats?.tasksDueToday ?? 0} due today.\n\n` : "";
  return `${summary}${priorityText}${uncertainty}\n\n${scope}${result.coverage.outputTruncated ? " Detail lists are capped at 10 entries and the context-size limit; counts precede those output limits." : ""}`;
}
