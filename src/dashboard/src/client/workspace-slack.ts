import { esc } from "./format";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";

type Capability = { ready: boolean; message?: string };
type SlackStatus = {
  configured: boolean;
  environment?: boolean;
  reconnect?: string | null;
  redirectUrl?: string;
  eventsUrl?: string;
  connection: { teamId: string; teamName: string | null; appId: string; botUserId: string } | null;
  login?: { teamId: string; teamName: string | null } | null;
  capabilities: (Record<keyof typeof LABELS, Capability> & { missing: string[] }) | null;
};

type SlackLink = {
  slackUserId: string;
  channelId: string;
  name: string | null;
  userId: string;
  active: boolean;
};

const LABELS = {
  threads: "Channel threads",
  directMessages: "App messages",
  agent: "Agent status",
  members: "Member checks",
  code: "Slack Code",
};
const RESULTS: Record<string, string> = {
  connected: "Slack is connected.",
  denied: "Slack authorization was declined. The existing connection is unchanged.",
  different_team: "Slack returned another workspace or app. Disconnect first to switch.",
  team_taken: "That Slack workspace is connected to another Paws workspace.",
  conflict: "The connection changed while you were in Slack. Start again.",
  expired: "That Slack link expired or was already used. Start again.",
  forbidden: "Only a workspace admin can connect Slack.",
  failed: "Slack could not be connected. Try again.",
};

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 shrink-0"><path d="${path}"></path></svg>`;
const CHECK = icon("M20 6 9 17l-5-5");
const ALERT = icon("M12 3 2 21h20L12 3zM12 10v4M12 17.5h.01");
const DASH = icon("M5 12h14");

const FIELDS: [string, string, string][] = [
  ["clientId", "Client ID", "text"],
  ["clientSecret", "Client secret", "password"],
  ["signingSecret", "Signing secret", "password"],
];
const FORM = `<form class="col" data-slack-app>${FIELDS.map(
  ([name, label, type]) =>
    `<label class="field"><span>${label}</span><input name="${name}" type="${type}" required maxlength="512" autocomplete="off" spellcheck="false"></label>`,
).join("")}<button class="btn primary" type="submit">Save</button></form>`;

export function initializeWorkspaceSlack(root: HTMLElement, csrfToken: string): void {
  const section = document.createElement("section");
  section.id = "workspace-slack-integration";
  section.dataset.settingsPage = "integrations";
  section.className = "settings-section";
  root.append(section);
  const params = new URLSearchParams(location.search);
  let notice = RESULTS[params.get("slack") ?? ""] ?? "";
  let detailsOpen = false;
  if (params.has("slack")) history.replaceState(null, "", location.pathname);

  async function load() {
    const response = await fetch("/api/workspaces/slack", { cache: "no-store" });
    if (!response.ok)
      return renderMarkup(section, '<p role="alert">Slack could not be checked.</p>');
    const {
      configured,
      environment,
      connection,
      capabilities,
      redirectUrl,
      eventsUrl,
      login,
      reconnect,
    } = (await response.json()) as SlackStatus;
    const linked = connection
      ? await fetch("/api/workspaces/slack/links", { cache: "no-store" })
          .then((reply) => (reply.ok ? (reply.json() as Promise<{ links: SlackLink[] }>) : null))
          .catch(() => null)
      : null;
    const links = linked?.links?.length
      ? `<h3>Linked members</h3><table tabindex="0" aria-label="Linked Slack members" class="members-table" data-slack-links><thead><tr><th scope="col">Paws member</th><th scope="col">Slack user</th><th scope="col">Channel</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${linked.links
          .map(
            (link) =>
              `<tr data-slack-link="${esc(link.slackUserId)}"><td><div>${esc(link.name ?? link.userId)}</div>${link.name ? `<div class="sub text-muted-foreground">${esc(link.userId)}</div>` : ""}${link.active ? "" : '<div class="sub text-muted-foreground">Paws access revoked</div>'}</td><td><code>${esc(link.slackUserId)}</code></td><td><code>${esc(link.channelId)}</code></td><td><button class="btn" data-slack-revoke="${esc(link.slackUserId)}">Revoke</button></td></tr>`,
          )
          .join("")}</tbody></table>`
      : connection
        ? '<p data-slack-links class="muted">No Slack members are linked.</p>'
        : "";
    const cells = Object.entries(LABELS).flatMap(([name, label]) => {
      const item = capabilities?.[name as keyof typeof LABELS];
      if (!item) return [];
      const [glyph, tone, word] = item.ready
        ? [CHECK, "text-state-ok", "Ready"]
        : name === "code"
          ? [DASH, "text-muted-foreground", "Not available on this connection yet"]
          : [ALERT, "text-state-awaiting", esc(item.message ?? "Not ready")];
      return `<div data-capability="${name}" class="flex min-w-0 flex-col gap-1 rounded-base border border-border p-3"><span class="text-sm font-semibold">${label}</span><span class="flex items-start gap-1.5 text-sm ${tone}">${glyph}<span data-capability-state>${word}</span></span></div>`;
    });
    const missing = capabilities?.missing ?? [];
    const attention =
      !!reconnect ||
      missing.length > 0 ||
      Object.keys(LABELS).some(
        (name) => name !== "code" && capabilities?.[name as keyof typeof LABELS]?.ready === false,
      );
    const pill = !connection
      ? '<span class="pill" data-slack-pill>Not connected</span>'
      : attention
        ? '<span class="pill warn" data-slack-pill>Needs attention</span>'
        : '<span class="pill ok" data-slack-pill>Connected</span>';
    const actions = !configured
      ? []
      : connection
        ? [
            ["reconnect", "Reconnect"],
            ["disconnect", "Disconnect"],
          ]
        : [
            ...(login ? [["adopt", "Use the paws login slack connection"]] : []),
            ["connect", "Add to Slack"],
          ];
    const buttons = actions
      .map(
        ([id, label]) =>
          `<button class="btn${id === "disconnect" ? " destructive" : ""}" data-slack="${id}">${label}</button>`,
      )
      .join("");
    const field = (label: string, value: string) =>
      `<div class="flex min-w-0 flex-col gap-1"><span class="sub text-muted-foreground">${label}</span><code class="block w-full overflow-x-auto rounded-base border border-border bg-background p-2 whitespace-nowrap select-all [overflow-wrap:normal]">${esc(value)}</code></div>`;
    const details = `<details data-slack-details${detailsOpen || !connection ? " open" : ""}><summary>Connection details</summary>${
      connection
        ? `<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm"><dt class="sub text-muted-foreground">Team</dt><dd><code>${esc(connection.teamId)}</code></dd><dt class="sub text-muted-foreground">App</dt><dd><code>${esc(connection.appId)}</code></dd><dt class="sub text-muted-foreground">Bot</dt><dd><code>${esc(connection.botUserId)}</code></dd></dl>`
        : ""
    }${field("Redirect URL", redirectUrl ?? "")}${field("Events URL", eventsUrl ?? "")}</details>`;
    const status = connection
      ? ""
      : `<p data-slack-status role="status">${
          configured
            ? login
              ? `Not connected. <code>paws login slack</code> connected ${esc(login.teamName ?? login.teamId)} (${esc(login.teamId)}) on this server; you can use it here.`
              : "Not connected."
            : environment
              ? "The Slack app credentials in the server environment are incomplete."
              : "Enter the Slack app credentials. Create the app in Slack with the redirect and events URLs below."
        }${environment ? " The Slack app comes from the server environment." : ""}</p>`;
    renderMarkup(
      section,
      `<div><h2>Slack</h2><p class="sub">Install Paws in Slack. Installing gives Slack users no access to Paws or its repositories.</p></div><div class="settings-account"><div class="card w-full gap-4"><div class="between"><div class="row"><h3>Slack</h3>${connection ? `<span>${esc(connection.teamName ?? connection.teamId)}</span>` : ""}${pill}</div>${connection ? `<div class="row">${buttons}</div>` : ""}</div>${status}${
        missing.length
          ? `<div data-slack-missing role="alert" class="flex min-w-0 flex-col items-start gap-3 rounded-base border border-current/35 p-3 text-sm text-state-awaiting [&_button]:text-foreground"><p>Paws needs ${missing.length} more Slack permission${missing.length === 1 ? "" : "s"}: ${missing.map(esc).join(", ")}. Reconnect to grant them.</p><button class="btn" data-slack="reconnect">Reconnect</button></div>`
          : ""
      }${reconnect ? `<p data-slack-reconnect role="alert" class="text-state-awaiting">${esc(reconnect)}</p>` : ""}${
        cells.length
          ? `<div class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-2">${cells.join("")}</div>`
          : ""
      }${details}${configured || environment ? "" : FORM}${links}<p data-slack-notice role="alert">${esc(notice)}</p>${connection ? "" : `<div class="row">${buttons}</div>`}</div></div>`,
    );
    section.querySelector("[data-slack-details]")?.addEventListener("toggle", (event) => {
      if (connection) detailsOpen = (event.currentTarget as HTMLDetailsElement).open;
    });
    for (const button of section.querySelectorAll<HTMLButtonElement>("[data-slack]"))
      button.addEventListener("click", () => void act(button.dataset.slack!));
    for (const button of section.querySelectorAll<HTMLButtonElement>("[data-slack-revoke]"))
      button.addEventListener("click", () => void revoke(button.dataset.slackRevoke!));
    section
      .querySelector<HTMLFormElement>("[data-slack-app]")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        void save(event.currentTarget as HTMLFormElement);
      });
  }

  async function save(form: HTMLFormElement) {
    const data = new FormData(form);
    const response = await fetch("/api/settings/slack-app", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
      body: JSON.stringify(Object.fromEntries(FIELDS.map(([name]) => [name, data.get(name)]))),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    notice = response.ok ? "Saved" : (body.error ?? "The Slack app could not be saved.");
    await load();
  }

  async function revoke(slackUserId: string) {
    const query = new URLSearchParams({ user: slackUserId });
    const response = await fetch(`/api/workspaces/slack/links?${query}`, {
      method: "DELETE",
      headers: { "x-paws-csrf": csrfToken },
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    notice = response.ok
      ? `Revoked the Slack link for ${slackUserId}.`
      : (data.error ?? "The Slack link could not be revoked.");
    await load();
  }

  async function act(action: string) {
    const disconnect = action === "disconnect";
    if (
      disconnect &&
      !confirm("Disconnect Slack? Paws stops answering in Slack until you connect it again.")
    )
      return;
    const path = disconnect ? "" : action === "adopt" ? "/adopt" : "/connect";
    const response = await fetch(`/api/workspaces/slack${path}`, {
      method: disconnect ? "DELETE" : "POST",
      headers: { "x-paws-csrf": csrfToken },
    });
    const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
    if (response.ok && data.url) return location.assign(data.url);
    const done = action === "adopt" ? RESULTS.connected! : "Slack is disconnected.";
    notice = response.ok ? done : (data.error ?? RESULTS.failed!);
    await load();
  }

  loadWhenShown("integrations", () => void load());
}
