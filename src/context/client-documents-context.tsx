"use client";

import { createContext, useContext, type ReactNode } from "react";

const SelfHostedClientDocumentsContext = createContext(false);

/** Server-supplied product visibility only; tenant/role authorization is separate. */
export function ClientDocumentsProvider({
  selfHosted,
  children,
}: {
  selfHosted: boolean;
  children: ReactNode;
}) {
  return (
    <SelfHostedClientDocumentsContext.Provider value={selfHosted}>
      {children}
    </SelfHostedClientDocumentsContext.Provider>
  );
}

export function useSelfHostedClientDocuments(): boolean {
  return useContext(SelfHostedClientDocumentsContext);
}
