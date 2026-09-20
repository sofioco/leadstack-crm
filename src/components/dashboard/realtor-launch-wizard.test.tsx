import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RealtorLaunchWizard } from "./realtor-launch-wizard";
import { WORKSPACE_PRESENTATION } from "@/config/workspace-presentation";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  WORKSPACE_PRESENTATION.showRealEstate = false;
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); WORKSPACE_PRESENTATION.showRealEstate = false; });

function mount(initialRole?: "solo_agent") {
  return render(<RealtorLaunchWizard subAccountId="test-workspace" saPath={(path) => `/sa/test-workspace${path}`} initialRole={initialRole} />);
}

it.each([
  ["Local Service Business", "solo_agent"],
  ["Professional Services", "team_lead"],
  ["Ecommerce / Retail", "brokerage"],
  ["Other", "other"],
])("keeps the existing API value for %s", async (label, value) => {
  mount();
  expect(screen.getByText("Welcome to MAROS")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
  expect(mocks.fetch).toHaveBeenCalledWith("/api/sub-accounts/test-workspace/onboarding", expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ realtorRole: value }),
  }));
});

it("preserves all five steps, completion payload and destination without generic MLS setup", async () => {
  mount();
  expect(screen.getByText("1 of 5")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Local Service Business/ }));
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("2 of 5")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Get more leads/ }));
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("3 of 5")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Skip for now/ }));
  expect(screen.getByText("4 of 5")).toBeInTheDocument();
  expect(screen.queryByText("Listings + MLS")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Website \+ domain/ }));
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("5 of 5")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Take me there/ }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/sa/test-workspace/domain"));
  expect(mocks.fetch).toHaveBeenCalledWith("/api/sub-accounts/test-workspace/onboarding", expect.objectContaining({
    body: JSON.stringify({ steps: [], wizardCompleted: true, realtorRole: "solo_agent", launchPriority: "get_leads" }),
  }));
});

it("resumes an existing stored answer at the next step", () => {
  mount("solo_agent");
  expect(screen.getByText("2 of 5")).toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("retains the specialist connection when real-estate presentation is enabled", async () => {
  WORKSPACE_PRESENTATION.showRealEstate = true;
  render(<RealtorLaunchWizard subAccountId="test-workspace" saPath={(path) => path} initialRole="solo_agent" initialPriority="get_leads" />);
  await userEvent.click(screen.getByRole("button", { name: /Skip for now/ }));
  expect(screen.getByText("Listings + MLS")).toBeInTheDocument();
});
