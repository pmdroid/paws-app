import { esc } from "./format";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";

type OwnLink = {
  connected: boolean;
  link: { teamId: string; channelId: string; slackUserId: string } | null;
};

export function initializeWorkspaceSlackLink(root: HTMLElement, csrfToken: string): void {
  const section = document.createElement("section");
  section.id = "workspace-slack-link";
  section.dataset.settingsPage = "account";
  section.className = "settings-section";
  root.append(section);
  let notice = "";

  async function load() {
    const response = await fetch("/api/workspaces/slack/link", { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as OwnLink | null;
    if (!response.ok || !data)
      return renderMarkup(section, '<p role="alert">Your Slack link could not be checked.</p>');
    if (!data.connected && !notice) return renderMarkup(section, "");
    const { link } = data;
    renderMarkup(
      section,
      `<div><h2>Slack</h2><p class="sub">Paws answers your @Paws mentions in Slack only while your Slack account is linked.</p></div><div class="settings-account"><p data-slack-link role="status">${
        link
          ? `Linked to Slack user <code>${esc(link.slackUserId)}</code> in workspace <code>${esc(link.teamId)}</code>, channel <code>${esc(link.channelId)}</code>.`
          : "Not linked. Mention @Paws in the Slack channel to link."
      }</p><p data-slack-link-notice role="alert">${esc(notice)}</p>${
        link ? '<button class="btn" data-slack-unlink>Unlink</button>' : ""
      }</div>`,
    );
    section
      .querySelector<HTMLButtonElement>("[data-slack-unlink]")
      ?.addEventListener("click", () => void unlink());
  }

  async function unlink() {
    const response = await fetch("/api/workspaces/slack/link", {
      method: "DELETE",
      headers: { "x-paws-csrf": csrfToken },
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    notice = response.ok ? "Unlinked." : (data.error ?? "Slack could not be unlinked.");
    await load();
  }

  loadWhenShown("account", () => void load());
}
