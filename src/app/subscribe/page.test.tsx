import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/billing/required-subscription", () => ({
  RequiredSubscription: () => <div>Required subscription</div>,
}));

import SubscribePage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SELF_HOSTED_MODE", undefined);
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(() => vi.unstubAllEnvs());

it("preserves hosted checkout by default", () => {
  render(<SubscribePage />);
  expect(screen.getByText("Required subscription")).toBeInTheDocument();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it("redirects self-hosted checkout visits to the protected dashboard", () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  expect(() => SubscribePage()).toThrow("NEXT_REDIRECT");
  expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
});
