import { Suspense } from "react";
import { redirect } from "next/navigation";
import { isSelfHostedDeployment } from "@/lib/auth/deployment-entitlement";
import { RequiredSubscription } from "@/components/billing/required-subscription";

export default function SubscribePage() {
  if (isSelfHostedDeployment()) redirect("/dashboard");
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#FFF6E8] px-4 py-10">
      <Suspense fallback={<div className="h-96 w-full max-w-lg rounded-3xl bg-white" />}>
        <RequiredSubscription />
      </Suspense>
    </main>
  );
}
