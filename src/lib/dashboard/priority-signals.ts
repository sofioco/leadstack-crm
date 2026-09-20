import { toMillis } from "@/lib/briefing/compute";

export const DAY_MS = 86_400_000;

function millis(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : toMillis(value);
}

export function isNewLead(contact: { createdAt: unknown }, nowMs: number): boolean {
  return (millis(contact.createdAt) ?? 0) >= nowMs - DAY_MS;
}

export function isOpenDeal(deal: { stageId: string }): boolean {
  return deal.stageId !== "won" && deal.stageId !== "lost";
}

/** Reading a thread clears its badge, not the outstanding inbound reply. */
export function needsConversationReply(conversation: { status?: unknown; lastDirection?: unknown }): boolean {
  return conversation.status === "open" && conversation.lastDirection === "inbound";
}

export function isStalledDeal(deal: { stageId: string; stageChangedAt: unknown }, nowMs: number): boolean {
  const changed = millis(deal.stageChangedAt) ?? 0;
  return isOpenDeal(deal) && deal.stageId !== "new" && changed > 0 && nowMs - changed >= 7 * DAY_MS;
}

export function isAssignedFollowUp(
  task: { completed: boolean; assignedToUid?: string | null; createdByUid: string; dueAt: unknown },
  uid: string | undefined,
  beforeMs: number,
): boolean {
  const due = millis(task.dueAt);
  return !task.completed && (task.assignedToUid ?? task.createdByUid) === uid && due !== null && due < beforeMs;
}
