export const SETTINGS_PAGES = [
  {
    id: "decisions",
    name: "Decisions",
    description: "Save and maintain answers your team can reuse.",
  },
  {
    id: "agents",
    name: "Agents",
    description:
      "Choose the agents that implement and review your work. Check each connection on an installed runner after sign-in.",
  },
  {
    id: "merging",
    name: "Merging",
    description:
      "Choose how accepted pull requests reach main, for the workspace, a Linear project, or a kind of issue.",
  },
  {
    id: "integrations",
    name: "Integrations",
    description: "Connect the services your workspace uses.",
  },
  {
    id: "workspace",
    name: "Workspace access",
    description: "Manage members, roles, and repository access.",
  },
  {
    id: "account",
    name: "Your account",
    description: "Manage your sign-in and public GitHub credit.",
  },
  {
    id: "audit",
    name: "Audit history",
    description: "Review changes to workspace access and settings.",
  },
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];

export function renderSettingsPage(page: SettingsPage = "agents"): string {
  const current = SETTINGS_PAGES.find((entry) => entry.id === page)!;
  return `<h1 class="sr-only">${current.name}</h1><p class="sub">${current.description}</p>${page === "agents" ? '<div id="checkout-settings" class="skill-settings"></div><div id="skill-settings" class="skill-settings"></div><div id="hook-settings" class="skill-settings"></div><div id="agent-settings" class="agent-settings"></div>' : page === "merging" ? '<div id="merge-settings" class="agent-settings"></div>' : ""}`;
}
