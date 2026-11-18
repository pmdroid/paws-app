import { esc } from "./format";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";

type Capability = { ready: boolean; message?: string };
type SlackStatus = {
  configured: boolean;
  redirectUrl?: string;
  eventsUrl?: string;
  connection: { teamId: string; teamName: string | null; appId: string; botUserId: string } | null;
  capabilities: (Record<keyof typeof LABELS, Capability> & { missing: string[] }) | null;
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
  rotating: "Turn off token rotation for this Slack app, then reconnect.",
};

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
    const { configured, connection, capabilities, redirectUrl, eventsUrl } =
      (await response.json()) as SlackStatus;
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
        : [["connect", "Add to Slack"]];
    renderMarkup(
      section,
      `<div><h2>Slack</h2><p class="sub">Install Paws in Slack. Installing gives Slack users no access to Paws or its repositories.</p></div><div class="settings-account"><p data-slack-status role="status">${
        connection
          ? `Connected to ${esc(connection.teamName ?? connection.teamId)} (${esc(connection.teamId)}), app ${esc(connection.appId)}, bot ${esc(connection.botUserId)}.`
          : configured
            ? "Not connected."
            : "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET on the server."
      }</p><ul>${rows.join("")}</ul>${
        capabilities?.missing.length
          ? `<p data-slack-missing>Missing scopes: ${capabilities.missing.map(esc).join(", ")}</p>`
          : ""
      }<p class="muted">Redirect URL <code>${esc(redirectUrl ?? "")}</code>, events URL <code>${esc(eventsUrl ?? "")}</code></p><p data-slack-notice role="alert">${esc(notice)}</p><div class="row">${actions
        .map(([id, label]) => `<button class="btn" data-slack="${id}">${label}</button>`)
        .join("")}</div></div>`,
    );
    for (const button of section.querySelectorAll<HTMLButtonElement>("[data-slack]"))
      button.addEventListener("click", () => void act(button.dataset.slack!));
  }

  async function act(action: string) {
    const disconnect = action === "disconnect";
    const response = await fetch(`/api/workspaces/slack${disconnect ? "" : "/connect"}`, {
      method: disconnect ? "DELETE" : "POST",
      headers: { "x-paws-csrf": csrfToken },
    });
    const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
    if (response.ok && data.url) return location.assign(data.url);
    notice = response.ok ? "Slack is disconnected." : (data.error ?? RESULTS.failed!);
    await load();
  }

  loadWhenShown("integrations", () => void load());
}
