/** Presentation only: routes, permissions and stored onboarding values stay intact. */
export const WORKSPACE_PRESENTATION = {
  // Legacy realtorRole answers are not a reliable industry discriminator.
  // An industry-specific deployment can opt in without changing the CRM schema.
  showRealEstate: false,
};

export function isWorkspaceNavVisible(href: string): boolean {
  return WORKSPACE_PRESENTATION.showRealEstate ||
    (href !== "/properties" && href !== "/idx");
}
