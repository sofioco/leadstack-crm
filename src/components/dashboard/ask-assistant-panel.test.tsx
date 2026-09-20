import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskAssistantButton, AskAssistantPanel } from "./ask-assistant-panel";

vi.mock("next/navigation", () => ({ usePathname: () => "/sa/test-workspace/dashboard", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { displayName: "Test Owner" } }) }));
afterEach(() => vi.unstubAllGlobals());

it("opens the existing assistant event with MAROS AI branding without making an AI request", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const listener = vi.fn();
  window.addEventListener("agentstack:ask-assistant", listener);
  render(<><AskAssistantButton /><AskAssistantPanel /></>);
  await userEvent.click(screen.getByRole("button", { name: "MAROS AI" }));
  expect(listener).toHaveBeenCalledOnce();
  expect(screen.getByPlaceholderText("Ask MAROS AI…")).toBeInTheDocument();
  expect(screen.getByText("Allow MAROS AI to use this screen")).toBeInTheDocument();
  expect(screen.queryByText(/Ask Zack|AgentStack/)).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  window.removeEventListener("agentstack:ask-assistant", listener);
});
