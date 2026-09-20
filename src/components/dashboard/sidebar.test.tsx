import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./sidebar";
import { WORKSPACE_PRESENTATION } from "@/config/workspace-presentation";
import { ClientDocumentsProvider } from "@/context/client-documents-context";

const mocks = vi.hoisted(() => ({
  openAssistant: vi.fn(),
  multiAccountMode: false,
  broadcastsEnabled: true,
  memberships: [{ subAccountId: "test-workspace", name: "Client workspace" }],
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/sa/test-workspace/dashboard" }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ agencyRole: "owner", memberships: mocks.memberships, membershipsLoaded: true, loading: false }) }));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => ({ name: "Test Agency", logoUrl: null, multiAccountModeEnabled: mocks.multiAccountMode }) }));
vi.mock("@/hooks/use-due-today", () => ({ useDueTodayCount: () => 0 }));
vi.mock("@/hooks/use-unread-conversations", () => ({ useUnreadConversationsCount: () => 0 }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: vi.fn() }));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: vi.fn() }));
vi.mock("firebase/firestore", () => ({ doc: vi.fn(), onSnapshot: (_ref: unknown, callback: (snap: unknown) => void) => {
  callback({ data: () => ({ broadcastsEnabledByAgency: mocks.broadcastsEnabled, broadcastsHiddenWhenDisabled: true, websiteStudioEnabledByAgency: true, socialPlannerEnabledByAgency: true, communityEnabledByAgency: true }) });
  return vi.fn();
} }));
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
  mocks.multiAccountMode = false;
  mocks.broadcastsEnabled = true;
  WORKSPACE_PRESENTATION.showRealEstate = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ score: 0 }) }));
});
afterEach(() => { vi.unstubAllGlobals(); WORKSPACE_PRESENTATION.showRealEstate = false; });

it("shows MAROS and the existing workspace name while preserving normal routes and AI", async () => {
  render(<Sidebar open={false} onOpenChange={vi.fn()} />);
  expect(screen.getByText("MAROS")).toBeInTheDocument();
  expect(screen.getByText("Client workspace")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Contacts" })).toHaveAttribute("href", "/sa/test-workspace/contacts");
  expect(screen.getByRole("link", { name: "Deals" })).toHaveAttribute("href", "/sa/test-workspace/pipeline");
  expect(screen.getByRole("link", { name: "Sub-accounts" })).toHaveAttribute("href", "/agency/sub-accounts");
  expect(screen.queryByRole("link", { name: "Properties" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Marketing" }));
  expect(screen.queryByRole("link", { name: "Listings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Property Campaigns" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Automations" })).toHaveAttribute("href", "/sa/test-workspace/workflows");
  expect(screen.getByRole("link", { name: "Landing Pages" })).toHaveAttribute("href", "/sa/test-workspace/funnels");
  expect(screen.getByRole("link", { name: "Email Campaigns" })).toHaveAttribute("href", "/sa/test-workspace/broadcasts");
  expect(screen.getByRole("link", { name: "Lead Capture" })).toHaveAttribute("href", "/sa/test-workspace/forms");
  await userEvent.click(screen.getByRole("button", { name: "MAROS AI" }));
  expect(mocks.openAssistant).toHaveBeenCalledOnce();
});

it("preserves specialist routes when real-estate presentation is enabled", async () => {
  WORKSPACE_PRESENTATION.showRealEstate = true;
  render(<Sidebar open={false} onOpenChange={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Properties" })).toHaveAttribute("href", "/sa/test-workspace/properties");
  await userEvent.click(screen.getByRole("button", { name: "Marketing" }));
  expect(screen.getByRole("link", { name: "Listings" })).toHaveAttribute("href", "/sa/test-workspace/idx");
  expect(screen.getByRole("link", { name: "Property Campaigns" })).toHaveAttribute("href", "/sa/test-workspace/marketing/campaigns");
});

it.each([
  { selfHosted: false, multiAccount: false, visible: false },
  { selfHosted: false, multiAccount: true, visible: true },
  { selfHosted: true, multiAccount: false, visible: true },
])("keeps client document navigation consistent: %j", async ({ selfHosted, multiAccount, visible }) => {
  mocks.multiAccountMode = multiAccount;
  render(<ClientDocumentsProvider selfHosted={selfHosted}><Sidebar open={false} onOpenChange={vi.fn()} /></ClientDocumentsProvider>);
  await userEvent.click(screen.getByRole("button", { name: "Sales & Engagement" }));
  await userEvent.click(screen.getByRole("button", { name: "Connect & Set Up" }));
  for (const [name, path] of [["Quotes & Invoices", "/quotes"], ["Products", "/products"]]) {
    const link = screen.queryByRole("link", { name });
    if (visible) expect(link).toHaveAttribute("href", `/sa/test-workspace${path}`);
    else expect(link).not.toBeInTheDocument();
  }
  for (const [name, path] of [["Calendar", "/calendar"], ["Booking", "/booking"], ["Conversations", "/conversations"], ["Tasks", "/tasks"], ["AI Assistants", "/ai-agents"], ["Analytics", "/reports"], ["Business Blueprint", "/business-profile"], ["Connect", "/connect"], ["Site Health", "/site-health"], ["Media Library", "/media"], ["Domain", "/domain"], ["Website Studio", "/website-studio"], ["Templates", "/templates"], ["Logs", "/logs"], ["Settings", "/dashboard/settings"]]) {
    expect(screen.getByRole("link", { name: name === "Site Health" ? /^Site Health/ : name })).toHaveAttribute("href", `/sa/test-workspace${path}`);
  }
});

it("does not enable email campaigns just because client documents are self-hosted", async () => {
  mocks.broadcastsEnabled = false;
  render(<ClientDocumentsProvider selfHosted><Sidebar open={false} onOpenChange={vi.fn()} /></ClientDocumentsProvider>);
  await userEvent.click(screen.getByRole("button", { name: "Marketing" }));
  expect(screen.queryByRole("link", { name: "Email Campaigns" })).not.toBeInTheDocument();
});
