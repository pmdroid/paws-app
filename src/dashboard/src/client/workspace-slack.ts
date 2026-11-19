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
      ? `<h3>Linked members</h3><ul data-slack-links>${linked.links
          .map(
            (link) =>
              `<li data-slack-link="${esc(link.slackUserId)}">${esc(link.name ?? link.userId)} as <code>${esc(link.slackUserId)}</code> in <code>${esc(link.channelId)}</code>${link.active ? "" : " (Paws access revoked)"} <button class="btn" data-slack-revoke="${esc(link.slackUserId)}">Revoke</button></li>`,
          )
          .join("")}</ul>`
      : connection
        ? '<p data-slack-links class="muted">No Slack members are linked.</p>'
        : "";
    const rows = Object.entries(LABELS).map(([name, label]) => {
      const item = capabilities?.[name as keyof typeof LABELS];
      return item
        ? `<li data-capability="${name}">${label}: ${item.ready ? "Ready" : esc(item.message ?? "")}</li>`
        : "";
    });
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
    renderMarkup(
      section,
      `<div><h2>Slack</h2><p class="sub">Install Paws in Slack. Installing gives Slack users no access to Paws or its repositories.</p></div><div class="settings-account"><p data-slack-status role="status">${
        connection
          ? `Connected to ${esc(connection.teamName ?? connection.teamId)} (${esc(connection.teamId)}), app ${esc(connection.appId)}, bot ${esc(connection.botUserId)}.`
          : configured
            ? login
              ? `Not connected. <code>paws login slack</code> connected ${esc(login.teamName ?? login.teamId)} (${esc(login.teamId)}) on this server; you can use it here.`
              : "Not connected."
            : environment
              ? "The Slack app credentials in the server environment are incomplete."
              : "Enter the Slack app credentials. Create the app in Slack with the redirect and events URLs below."
      }${environment ? " The Slack app comes from the server environment." : ""}</p>${reconnect ? `<p data-slack-reconnect role="alert">${esc(reconnect)}</p>` : ""}<ul>${rows.join("")}</ul>${
        capabilities?.missing.length
          ? `<p data-slack-missing>Missing scopes: ${capabilities.missing.map(esc).join(", ")}</p>`
          : ""
      }<p class="muted">Redirect URL <code>${esc(redirectUrl ?? "")}</code>, events URL <code>${esc(eventsUrl ?? "")}</code></p>${configured || environment ? "" : FORM}${links}<p data-slack-notice role="alert">${esc(notice)}</p><div class="row">${actions
        .map(([id, label]) => `<button class="btn" data-slack="${id}">${label}</button>`)
        .join("")}</div></div>`,
    );
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
