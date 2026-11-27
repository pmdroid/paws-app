import { routePath, type Route } from "./route";

export const USER_SETTINGS_PAGES = [
  {
    id: "account",
    name: "Your account",
    description: "Manage your sign-in and public GitHub credit.",

    sections: ["Linear account", "Sign out", "GitHub credit"],
  },
  {
    id: "agent-accounts",
    name: "Agent accounts",
    description: "The workspace's agent sign-ins, in the order runs try them.",

    sections: [
      "Add an account",
      "Account name",
      "API key",
      "Setup token",
      "Sign in with",
      "Replace setup token",
    ],
  },
] as const;

export const WORKSPACE_PAGES = [
  {
    id: "agents",
    name: "Agents",
    description:
      "Choose the agents that implement and review your work. Check each connection on an installed runner after sign-in. Sign in to each agent per runner on the Runners page.",

    sections: ["Global defaults", "Label presets", "Agent", "Model", "Effort"],
  },
  {
    id: "merging",
    name: "Merging",
    description: "Choose how accepted pull requests reach main.",

    sections: [
      "Merge lanes",
      "Merge order",
      "Merges at once in a lane",
      "When main moved before the merge",
      "CI fix attempts",
      "High-risk approval",
      "High-risk paths",
      "Conflict-prone files",
      "Pull request checks",
      "Pull request comments",
      "Ignored PR comments",
      "Issues without a project",
      "Repositories and projects",
      "When Paws finishes the Linear session",
      "Suggested findings",
    ],
  },
  {
    id: "repositories",
    name: "Repositories",
    description: "Repository access and local Closeout policies.",

    sections: [
      "GitHub access",
      "Repository descriptions",
      "Closeout policy roots",
      "Comment agents",
      "Policy root",
    ],
  },
  {
    id: "closeout",
    name: "Closeout",
    description:
      "What Closeout runs again after a conflict fix or a failed CI check, and how each repository's test checks pick their tests. Each repository sets this in its .agents/closeout.yaml; change it there in a pull request. GitHub CI always runs the full suite before a merge.",

    sections: ["Reruns", "Test selection"],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Choose which Linear agents may comment.",
    sections: ["Comment agents"],
  },
  {
    id: "storage",
    name: "Storage",
    description: "Object storage, Closeout log retention, disk use and cleanups.",

    sections: [
      "Storage kind",
      "Closeout logs",
      "Disk use",
      "Cleanup schedule and rules",
      "Cleanup history",
      "Clean up the Paws server",
    ],
  },
  {
    id: "limits",
    name: "Queue and limits",
    description: "How long work may wait and run, and how much runs at once.",

    sections: ["Queue", "Time limits", "Most items one person or project runs at once"],
  },
  {
    id: "telemetry",
    name: "Telemetry",
    description: "Export metrics, alerts, item events and traces to an OpenTelemetry collector.",

    sections: ["Export to OpenTelemetry", "Destination", "What to export", "Send test"],
  },
  {
    id: "splits",
    name: "Issue splits",
    description:
      "Whether agents may split a too-big issue into sub-issues, and when splits stop needing a person's approval.",

    sections: [
      "Splits",
      "Most sub-issues in one split",
      "Approved splits before splits are automatic",
    ],
  },
  {
    id: "issue-vms",
    name: "Issue VMs",
    description:
      "How many issue VMs each member and the workspace may run, extra usage for members, each provider's VM size, and the size of each VM host's microVMs.",

    sections: ["Limits", "Extra usage", "VM sizes", "VM hosts"],
  },
  {
    id: "runner-vms",
    name: "Runner VMs",
    description:
      "Where Create VM can make runner VMs, whether each key still works, and the key that joins them to your tailnet.",

    sections: ["VM providers", "Network", "Tailnet requirements"],
  },
  {
    id: "brief",
    name: "Agent instructions",
    description: "What coding agents are told: the brief, skills and hooks.",

    sections: ["Agent brief", "Template", "Preview", "Skills", "Repository skill roots", "Hooks"],
  },
  {
    id: "integrations",
    name: "Integrations",
    description: "Connect the services your workspace uses.",

    sections: ["GitHub", "Configure the GitHub App", "Slack", "Linked members", "Prerequisites"],
  },
  {
    id: "performance",
    name: "Performance",
    description:
      "Why Paws is slow: event-loop lag, queues, calls to Linear and GitHub, and where an issue's time goes.",

    sections: [
      "At a glance",
      "Where an issue's time goes",
      "Responsiveness",
      "Queues",
      "Linear, GitHub and the dashboard",
    ],
  },
  {
    id: "members",
    name: "Members",
    description: "Change roles, and revoke or restore a member's access.",

    sections: ["Role", "Revoke access", "Restore access"],
  },
  {
    id: "audit",
    name: "Audit history",
    description: "Review changes to workspace access and settings.",

    sections: ["Recent changes"],
  },
] as const;

export const SETTINGS_PAGES = [...USER_SETTINGS_PAGES, ...WORKSPACE_PAGES];

export type UserSettingsPage = (typeof USER_SETTINGS_PAGES)[number]["id"];
export type WorkspacePage = (typeof WORKSPACE_PAGES)[number]["id"];
export type SettingsPage = UserSettingsPage | WorkspacePage;

let settingsAdmin = false;
const MEMBER_PAGES: readonly string[] = ["splits", "issue-vms"];
const memberPage = (page: string | null | undefined) => MEMBER_PAGES.includes(page ?? "");

function memberCanOpen(page: string | null | undefined): boolean {
  return isUserSettingsPage(page) || memberPage(page);
}

export function ownSettingsPages(): readonly { id: SettingsPage; name: string }[] {
  if (settingsAdmin) return USER_SETTINGS_PAGES;
  return [...USER_SETTINGS_PAGES, ...WORKSPACE_PAGES.filter((page) => memberPage(page.id))];
}
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
  if (settingsAdmin) return route.page ?? "agents";
  return route.page && memberPage(route.page) ? route.page : "account";
}

export type SettingsMatch = { id: SettingsPage; name: string; section: string | null };

export function settingsQuery(search: string): string {
  return new URLSearchParams(search).get("q") ?? "";
}

export function searchSettings(query: string): SettingsMatch[] {
  const needle = query.trim().toLowerCase();
  const pages = settingsAdmin
    ? SETTINGS_PAGES
    : SETTINGS_PAGES.filter((page) => memberCanOpen(page.id));
  const has = (text: string) => text.toLowerCase().includes(needle);
  return pages.flatMap((page) => {
    const section = (page.sections as readonly string[]).find(has) ?? null;
    return has(page.name) || has(page.description) || section !== null
      ? [{ id: page.id, name: page.name, section: has(page.name) ? null : section }]
      : [];
  });
}

export function settingsSearchPath(route: Route, query: string): string {
  const current = shownSettingsPage(route);
  const matches = searchSettings(query);
  const target =
    query.trim() === "" ? null : (matches.find((match) => match.id === current) ?? matches[0]);
  const path = routePath(target ? settingsPageRoute(target.id) : route);
  return query === "" ? path : `${path}?q=${encodeURIComponent(query)}`;
}

export function settingsRedirect(path: string): string | null {
  const [head, page] = path
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if ((head === "settings" || head === "workspace") && page === "notebook") return "/notebooks";
  if ((head === "settings" || head === "workspace") && page === "member-vm")
    return "/workspace/issue-vms#vm-sizes";
  if ((head === "settings" || head === "workspace") && page === "workspace")
    return settingsAdmin ? "/workspace/integrations" : "/settings/account";
  if (head === "settings" && isWorkspacePage(page))
    return settingsAdmin || memberPage(page) ? `/workspace/${page}` : "/settings/account";
  return head === "workspace" && !settingsAdmin && !memberPage(page) ? "/settings/account" : null;
}

export function renderSettingsPage(requested: SettingsPage = "account"): string {
  const page = settingsAdmin || memberCanOpen(requested) ? requested : "account";
  const current = SETTINGS_PAGES.find((entry) => entry.id === page)!;
  return `<h1>${current.name}</h1><div class="settings-body min-w-0 space-y-4"><p class="sub">${current.description}</p>${page === "repositories" || page === "linear" ? `<div id="${page}-settings"></div>` : page === "agents" ? '<div id="agent-settings" class="agent-settings"></div>' : page === "brief" ? '<div id="brief-settings" class="agent-settings"></div><div id="skill-settings" class="skill-settings"></div><div id="hook-settings" class="skill-settings"></div>' : page === "agent-accounts" ? '<div id="agent-account-settings" class="agent-settings"></div>' : page === "merging" ? '<div id="merge-settings" class="agent-settings"></div>' : page === "storage" ? '<div id="storage-settings" class="agent-settings"></div><div id="storage-disk-settings" class="agent-settings"></div>' : page === "telemetry" ? '<div id="telemetry-settings" class="agent-settings"></div>' : page === "issue-vms" ? '<div id="issue-vm-settings" class="agent-settings"></div>' : page === "splits" ? '<div id="split-settings" class="skill-settings"></div>' : page === "runner-vms" ? '<div id="runner-vm-keys" class="agent-settings"></div>' : page === "closeout" ? '<div id="closeout-settings" class="agent-settings"></div>' : page === "performance" ? '<div id="performance-settings"></div>' : page === "limits" ? '<div id="queue-settings" class="skill-settings"></div><div id="time-limit-settings" class="skill-settings"></div>' : page === "integrations" ? '<div id="doctor-checks"></div>' : ""}</div>`;
}
