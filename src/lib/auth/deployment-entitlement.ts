import "server-only";

/** Deployment-wide opt-in; never derive this entitlement from request data. */
export function isSelfHostedDeployment(): boolean {
  return process.env.SELF_HOSTED_MODE === "true";
}

export function requiresSubscription(subscriptionStatus?: unknown): boolean {
  return !isSelfHostedDeployment()
    && subscriptionStatus !== "active"
    && subscriptionStatus !== "trialing";
}
