import { routeHref, type Route } from "./route";

export const USER_SETTINGS_PAGES = [
  {
    id: "account",
    name: "Your account",
    description: "Manage your sign-in and public GitHub credit.",
  },
  {
    id: "agent-accounts",
    name: "Agent accounts",
    description: "The workspace's agent sign-ins, in the order runs try them.",
  },
] as const;

export const WORKSPACE_PAGES = [
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
    id: "repositories",
    name: "Repositories",
    description: "Repository access and local Closeout policies.",
  },
  { id: "linear", name: "Linear", description: "Choose which Linear agents may comment." },
  {
    id: "storage",
    name: "Storage",
    description: "Configure object storage and Closeout log retention.",
  },
  {
    id: "limits",
    name: "Queue and limits",
    description: "How long work may wait and run, and how much runs at once.",
  },
  {
    id: "member-vm",
    name: "Member VMs",
    description: "The size and pool exe.dev gives each new member VM.",
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
    description: "Manage members and repository access.",
  },
  {
    id: "audit",
    name: "Audit history",
    description: "Review changes to workspace access and settings.",
  },
] as const;

export const SETTINGS_PAGES = [...USER_SETTINGS_PAGES, ...WORKSPACE_PAGES];

export type UserSettingsPage = (typeof USER_SETTINGS_PAGES)[number]["id"];
export type WorkspacePage = (typeof WORKSPACE_PAGES)[number]["id"];
export type SettingsPage = UserSettingsPage | WorkspacePage;

let settingsAdmin = false;
export function settingsAreEditable(): boolean {
  return settingsAdmin;
}

export function setSettingsAdmin(admin: boolean): void {
  settingsAdmin = admin;
}

export function isUserSettingsPage(page: string | null | undefined): page is UserSettingsPage {
  return USER_SETTINGS_PAGES.some((entry) => entry.id === page);
}

export function isWorkspacePage(page: string | null | undefined): page is WorkspacePage {
  return WORKSPACE_PAGES.some((entry) => entry.id === page);
}

export function settingsPageRoute(page: SettingsPage): Route {
  return isWorkspacePage(page) ? { view: "workspace", page } : { view: "settings", page };
}

export function shownSettingsPage(route: Route): SettingsPage | null {
  if (route.view === "settings") return route.page ?? "account";
  if (route.view !== "workspace") return null;
  return settingsAdmin ? (route.page ?? "agents") : "account";
}

export function settingsRedirect(path: string): string | null {
  const [head, page] = path
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if (head === "settings" && isWorkspacePage(page))
    return settingsAdmin ? `/workspace/${page}` : "/settings/account";
  return head === "workspace" && !settingsAdmin ? "/settings/account" : null;
}

function settingsNav(page: SettingsPage): string {
  if (isWorkspacePage(page))
    return `<h1>${WORKSPACE_PAGES.find((entry) => entry.id === page)!.name}</h1>`;
  const links = USER_SETTINGS_PAGES.map(
    (entry) =>
      `<li class="settings-item"><a href="${routeHref(settingsPageRoute(entry.id))}"${entry.id === page ? ' aria-current="page"' : ""} class="settings-link">${entry.name}</a></li>`,
  ).join("");
  return `<nav aria-label="Settings pages" class="settings-nav min-w-0 overflow-x-auto"><ul class="flex w-max min-w-full list-none gap-1 border-b border-border">${links}</ul></nav>`;
}

export function renderSettingsPage(requested: SettingsPage = "account"): string {
  const page = settingsAdmin || isUserSettingsPage(requested) ? requested : "account";
  const current = SETTINGS_PAGES.find((entry) => entry.id === page)!;
  return `${settingsNav(page)}<div class="settings-body min-w-0 space-y-4"><p class="sub">${current.description}</p>${page === "repositories" || page === "linear" ? `<div id="${page}-settings"></div>` : page === "agents" ? '<div id="agent-settings" class="agent-settings"></div>' : page === "brief" ? '<div id="brief-settings" class="agent-settings"></div><div id="skill-settings" class="skill-settings"></div><div id="hook-settings" class="skill-settings"></div>' : page === "agent-accounts" ? '<div id="agent-account-settings" class="agent-settings"></div>' : page === "merging" ? '<div id="merge-settings" class="agent-settings"></div>' : page === "storage" ? '<div id="storage-settings" class="agent-settings"></div>' : page === "member-vm" ? '<div id="member-vm-settings" class="agent-settings"></div>' : page === "limits" ? '<div id="queue-settings" class="skill-settings"></div><div id="time-limit-settings" class="skill-settings"></div>' : ""}</div>`;
}
