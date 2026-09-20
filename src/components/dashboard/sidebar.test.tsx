import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./sidebar";
import { WORKSPACE_PRESENTATION } from "@/config/workspace-presentation";

const mocks = vi.hoisted(() => ({
  openAssistant: vi.fn(),
  memberships: [{ subAccountId: "test-workspace", name: "Client workspace" }],
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/sa/test-workspace/dashboard" }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ agencyRole: "owner", memberships: mocks.memberships, membershipsLoaded: true, loading: false }) }));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => ({ name: "Test Agency", logoUrl: null, multiAccountModeEnabled: false }) }));
vi.mock("@/hooks/use-due-today", () => ({ useDueTodayCount: () => 0 }));
vi.mock("@/hooks/use-unread-conversations", () => ({ useUnreadConversationsCount: () => 0 }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: vi.fn() }));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: vi.fn() }));
vi.mock("firebase/firestore", () => ({ doc: vi.fn(), onSnapshot: () => vi.fn() }));
vi.mock("@/components/dashboard/ask-assistant-panel", () => ({ openAskAssistant: mocks.openAssistant }));
vi.mock("@/components/pwa/install-callout", () => ({ InstallCallout: () => null }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  SheetContent: ({ children }: { children: ReactNode }) => children,
  SheetHeader: ({ children }: { children: ReactNode }) => children,
  SheetTitle: ({ children }: { children: ReactNode }) => children,
}));

beforeEach(() => {
  vi.clearAllMocks();
  WORKSPACE_PRESENTATION.showRealEstate = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ score: 0 }) }));
});
afterEach(() => { vi.unstubAllGlobals(); WORKSPACE_PRESENTATION.showRealEstate = false; });

it("shows MAROS and the existing workspace name while preserving normal routes and AI", async () => {
  render(<Sidebar open={false} onOpenChange={vi.fn()} />);
  expect(screen.getByText("MAROS")).toBeInTheDocument();
  expect(screen.getByText("Client workspace")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "People" })).toHaveAttribute("href", "/sa/test-workspace/contacts");
  expect(screen.getByRole("link", { name: "Deals" })).toHaveAttribute("href", "/sa/test-workspace/pipeline");
  expect(screen.getByRole("link", { name: "Sub-accounts" })).toHaveAttribute("href", "/agency/sub-accounts");
  expect(screen.queryByRole("link", { name: "Properties" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Marketing" }));
  expect(screen.queryByRole("link", { name: "Listings" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Lead Capture" })).toHaveAttribute("href", "/sa/test-workspace/forms");
  await userEvent.click(screen.getByRole("button", { name: "MAROS AI" }));
  expect(mocks.openAssistant).toHaveBeenCalledOnce();
});

it("preserves both specialist routes when real-estate presentation is enabled", async () => {
  WORKSPACE_PRESENTATION.showRealEstate = true;
  render(<Sidebar open={false} onOpenChange={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Properties" })).toHaveAttribute("href", "/sa/test-workspace/properties");
  await userEvent.click(screen.getByRole("button", { name: "Marketing" }));
  expect(screen.getByRole("link", { name: "Listings" })).toHaveAttribute("href", "/sa/test-workspace/idx");
});
