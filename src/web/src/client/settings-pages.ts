export const SETTINGS_PAGES = [
  {
    id: "agents",
    name: "Agents",
    description: "Choose the agents that implement and review your work.",
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
  return `<h1 class="sr-only">${current.name}</h1><p class="sub">${current.description}</p>${page === "agents" ? '<div id="agent-settings" class="agent-settings"></div>' : ""}`;
}
