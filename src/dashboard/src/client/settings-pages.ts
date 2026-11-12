import { routeHref } from "./route";

export const SETTINGS_PAGES = [
  {
    id: "agents",
    name: "Agents",
    description:
      "Choose the agents that implement and review your work. Check each connection on an installed runner after sign-in. Sign in to each agent per runner on the Runners page.",
    when: "Once at setup, to pick which agent writes code and which reviews it. The defaults work for a first run.",
  },
  {
    id: "merging",
    name: "Merging",
    description:
      "Choose how accepted pull requests reach main, for the workspace, a Linear project, or a kind of issue.",
    when: "Before your first merge if you want approvals on risky paths. Otherwise later.",
  },
  {
    id: "limits",
    name: "Queue and limits",
    description: "How long work may wait and run, and how much runs at once.",
    when: "When work waits too long or one person fills every slot. Not needed at first.",
  },
  {
    id: "brief",
    name: "Agent instructions",
    description: "What coding agents are told: the brief, skills and hooks.",
    when: "When agents keep missing a house rule. Your repository's AGENTS.md already reaches them.",
  },
  {
    id: "findings",
    name: "Findings",
    description: "Choose how Paws groups review findings for your team.",
    when: "After a week of merged work, when the Findings page has entries.",
  },
  {
    id: "integrations",
    name: "Integrations",
    description: "Connect the services your workspace uses.",
    when: "At setup. Linear and GitHub are required, Slack is optional.",
  },
  {
    id: "members",
    name: "Members",
    description: "Change roles, and revoke or restore a member's access.",
    when: "When someone joins or leaves the team.",
  },
  {
    id: "workspace",
    name: "Workspace access",
    description: "Manage repository access and what agents see of each repository.",
    when: "When you add a repository, or must hide a folder from agents.",
  },
  {
    id: "account",
    name: "Your account",
    description: "Manage your sign-in and public GitHub credit.",
    when: "Once, to link your GitHub account for commit credit.",
  },
  {
    id: "audit",
    name: "Audit history",
    description: "Review changes to workspace access and settings.",
    when: "Only to answer who changed something. Read-only.",
  },
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];

function settingsNav(page: SettingsPage): string {
  const links = SETTINGS_PAGES.map(
    (entry) =>
      `<li class="settings-item"><a href="${routeHref({ view: "settings", page: entry.id })}"${entry.id === page ? ' aria-current="page"' : ""} class="settings-link"><span>${entry.name}</span><span class="ml-auto font-mono text-[11px] text-muted-foreground">${entry.id === "account" ? "you" : "admin"}</span></a></li>`,
  ).join("");
  return `<nav aria-label="Settings pages" class="settings-nav min-w-0 overflow-x-auto"><ul class="flex list-none gap-1 md:flex-col">${links}</ul></nav>`;
}

export function renderSettingsPage(page: SettingsPage = "agents"): string {
  const current = SETTINGS_PAGES.find((entry) => entry.id === page)!;
  return `${settingsNav(page)}<div class="settings-body min-w-0 space-y-4"><h1 class="settings-title">${current.name}</h1><p class="sub">${current.description}</p><p class="settings-when rounded-base border border-border px-3 py-2 text-sm text-muted-foreground"><b class="font-medium text-foreground">When to touch this:</b> ${current.when}</p>${page === "agents" ? '<div id="agent-settings" class="agent-settings"></div>' : page === "brief" ? '<div id="brief-settings" class="agent-settings"></div><div id="skill-settings" class="skill-settings"></div><div id="hook-settings" class="skill-settings"></div>' : page === "merging" ? '<div id="merge-settings" class="agent-settings"></div>' : page === "limits" ? '<div id="queue-settings" class="skill-settings"></div><div id="time-limit-settings" class="skill-settings"></div>' : page === "findings" ? '<div id="finding-settings" class="skill-settings"></div>' : ""}</div>`;
}
