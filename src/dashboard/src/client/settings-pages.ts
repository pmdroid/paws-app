import { routeHref } from "./route";

export const SETTINGS_PAGES = [
  {
    id: "agents",
    name: "Agents",
    description:
      "Choose the agents that implement and review your work. Check each connection on an installed runner after sign-in. Sign in to each agent per runner on the Runners page.",
  },
  {
    id: "merging",
    name: "Merging",
    description: "Choose how accepted pull requests reach main.",
  },
  {
    id: "limits",
    name: "Queue and limits",
    description: "How long work may wait and run, and how much runs at once.",
  },
  {
    id: "brief",
    name: "Agent instructions",
    description: "What coding agents are told: the brief, skills and hooks.",
  },
  {
    id: "integrations",
    name: "Integrations",
    description: "Connect the services your workspace uses.",
  },
  {
    id: "members",
    name: "Members",
    description: "Change roles, and revoke or restore a member's access.",
  },
  {
    id: "workspace",
    name: "Workspace access",
    description: "Manage repository access and what agents see of each repository.",
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

function settingsNav(page: SettingsPage): string {
  const links = SETTINGS_PAGES.map(
    (entry) =>
      `<li class="settings-item"><a href="${routeHref({ view: "settings", page: entry.id })}"${entry.id === page ? ' aria-current="page"' : ""} class="settings-link">${entry.name}</a></li>`,
  ).join("");
  return `<nav aria-label="Settings pages" class="settings-nav min-w-0 overflow-x-auto"><ul class="flex w-max min-w-full list-none gap-1 border-b border-border">${links}</ul></nav>`;
}

export function renderSettingsPage(page: SettingsPage = "agents"): string {
  const current = SETTINGS_PAGES.find((entry) => entry.id === page)!;
  return `${settingsNav(page)}<div class="settings-body min-w-0 space-y-4"><p class="sub">${current.description}</p>${page === "agents" ? '<div id="agent-settings" class="agent-settings"></div>' : page === "brief" ? '<div id="brief-settings" class="agent-settings"></div><div id="skill-settings" class="skill-settings"></div><div id="hook-settings" class="skill-settings"></div>' : page === "merging" ? '<div id="merge-settings" class="agent-settings"></div>' : page === "limits" ? '<div id="queue-settings" class="skill-settings"></div><div id="time-limit-settings" class="skill-settings"></div>' : ""}</div>`;
}
