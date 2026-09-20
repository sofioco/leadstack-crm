import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RootLayout from "@/app/layout";
import QuotesLayout from "@/app/(dashboard)/sa/[subAccountId]/quotes/layout";
import { ClientDocumentsProvider } from "@/context/client-documents-context";
import { BrokerFeatureOnly } from "./broker-feature-only";

const agency = vi.hoisted(() => ({ loading: false, multiAccountModeEnabled: false }));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => agency }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ saPath: (path: string) => `/sa/workspace-1${path}` }) }));
vi.mock("@/components/providers", () => ({ Providers: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/affiliate/ref-tracker", () => ({ RefTracker: () => null }));
vi.mock("@/components/analytics-scripts", () => ({ AnalyticsScripts: () => null }));
vi.mock("@/app/globals.css", () => ({}));

beforeEach(() => {
  agency.loading = false;
  agency.multiAccountModeEnabled = false;
  vi.stubEnv("SELF_HOSTED_MODE", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); window.history.replaceState({}, "", "/"); localStorage.clear(); });

// Exercise the real server layout's entitlement prop without nesting html/body in jsdom.
function documentProvider(node: ReactNode): ReactElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === ClientDocumentsProvider) return child;
    const found = documentProvider(child.props.children);
    if (found) return found;
  }
  return null;
}

function renderQuoteAccess() {
  const layout = RootLayout({ children: <QuotesLayout><h1>Existing quotes and invoices</h1></QuotesLayout> });
  const provider = documentProvider(layout);
  expect(provider).not.toBeNull();
  render(provider!);
}

it("keeps the default hosted single-workspace quote/invoice gate", () => {
  renderQuoteAccess();
  expect(screen.getByRole("heading", { name: "Broker-level feature" })).toBeInTheDocument();
  expect(screen.queryByText("Existing quotes and invoices")).not.toBeInTheDocument();
});

it("preserves hosted multi-account access", () => {
  agency.multiAccountModeEnabled = true;
  renderQuoteAccess();
  expect(screen.getByText("Existing quotes and invoices")).toBeInTheDocument();
});

it("passes the server entitlement through to the existing quote/invoice layout", () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  renderQuoteAccess();
  expect(screen.getByText("Existing quotes and invoices")).toBeInTheDocument();
  expect(screen.queryByText("Broker-level feature")).not.toBeInTheDocument();
});

it("does not derive self-hosted access from browser configuration", () => {
  window.history.replaceState({}, "", "/sa/workspace-1/quotes?SELF_HOSTED_MODE=true&selfHosted=true");
  localStorage.setItem("SELF_HOSTED_MODE", "true");
  vi.stubEnv("NEXT_PUBLIC_SELF_HOSTED_MODE", "true");
  renderQuoteAccess();
  expect(screen.getByRole("heading", { name: "Broker-level feature" })).toBeInTheDocument();
});

it("defaults to gated without a server provider, even when an env exists in the test process", () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  render(<BrokerFeatureOnly>Existing products</BrokerFeatureOnly>);
  expect(screen.queryByText("Existing products")).not.toBeInTheDocument();
});

it("retains agency loading behavior", () => {
  vi.stubEnv("SELF_HOSTED_MODE", "true");
  agency.loading = true;
  renderQuoteAccess();
  expect(screen.queryByText("Existing quotes and invoices")).not.toBeInTheDocument();
});
