import { expect, it } from "vitest";
import { DAY_MS, isAssignedFollowUp, isNewLead, isOpenDeal, isStalledDeal } from "./priority-signals";

const now = Date.UTC(2026, 8, 21, 12);
const timestamp = (ms: number) => ({ seconds: ms / 1000 });

it("preserves Today's new-lead and seven-day stall boundaries", () => {
  expect(isNewLead({ createdAt: timestamp(now - DAY_MS) }, now)).toBe(true);
  expect(isNewLead({ createdAt: timestamp(now - DAY_MS - 1) }, now)).toBe(false);
  expect(isStalledDeal({ stageId: "qualified", stageChangedAt: timestamp(now - 7 * DAY_MS) }, now)).toBe(true);
  expect(isStalledDeal({ stageId: "qualified", stageChangedAt: timestamp(now - 7 * DAY_MS + 1) }, now)).toBe(false);
  for (const stageId of ["new", "won", "lost"]) expect(isStalledDeal({ stageId, stageChangedAt: timestamp(now - 20 * DAY_MS) }, now)).toBe(false);
  expect(isStalledDeal({ stageId: "proposal", stageChangedAt: null }, now)).toBe(false);
  expect(isOpenDeal({ stageId: "won" })).toBe(false);
});

it("preserves assigned-user, completed, legacy creator and end-of-day task behavior", () => {
  const task = { completed: false, createdByUid: "owner", assignedToUid: "member", dueAt: timestamp(now) };
  expect(isAssignedFollowUp(task, "member", now + 1)).toBe(true);
  expect(isAssignedFollowUp(task, "owner", now + 1)).toBe(false);
  expect(isAssignedFollowUp({ ...task, completed: true }, "member", now + 1)).toBe(false);
  expect(isAssignedFollowUp(task, "member", now)).toBe(false);
  expect(isAssignedFollowUp({ ...task, assignedToUid: null }, "owner", now + 1)).toBe(true);
  expect(isAssignedFollowUp({ ...task, dueAt: null }, "member", now + 1)).toBe(false);
});
