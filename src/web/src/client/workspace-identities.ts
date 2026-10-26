import { journalCaught } from "../journal";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";
import { esc } from "./format";

export function identityLinkMarkup(input: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  status: string;
  disabled: boolean;
}): string {
  const disabled = input.disabled ? " disabled" : "";
  return `<div class="identity-link"><label class="field" for="${esc(input.id)}">${esc(input.label)}</label><input id="${esc(input.id)}" value="${esc(input.value)}" autocomplete="off" maxlength="${input.maxLength}"${disabled}><span class="muted" data-identity-status>${esc(input.status)}</span><button type="submit"${disabled}>Save account</button></div>`;
}
type IdentityLink = {
  userId: string;
  provider: string;
  externalId: string | null;
  method: string;
  status: string;
};

export function initializeWorkspaceIdentities(root: HTMLElement, csrfToken: string) {
  const details = document.createElement("section");
  details.dataset.settingsPage = "workspace";
  details.className = "settings-section";
  renderMarkup(
    details,
    '<div><h2>Member account links</h2><p class="sub">Match members across Linear, Slack, and GitHub.</p></div><div><div class="workspace-identities"></div><p role="status"></p></div>',
  );
  root.append(details);
  const feedback = details.querySelector<HTMLElement>('[role="status"]')!;
  loadWhenShown("workspace", () => void load());
  async function load() {
    try {
      const response = await fetch("/api/workspaces/identity-links", { cache: "no-store" });
      if (!response.ok) throw new Error("Account links could not be loaded.");
      const data = (await response.json()) as {
        slackTeamId: string | null;
        links: IdentityLink[];
        members: { id: string; name: string; active: number }[];
      };
      const list = details.querySelector(".workspace-identities")!;
      for (const member of data.members.filter((entry) => entry.active)) {
        const name = document.createElement("h3");
        name.textContent = member.name;
        list.append(name);
        for (const provider of ["slack", "github"]) {
          const link = data.links.find(
            (entry) => entry.userId === member.id && entry.provider === provider,
          );
          const form = document.createElement("form");
          const unavailable = provider === "slack" && data.slackTeamId === null;
          renderMarkup(
            form,
            identityLinkMarkup({
              id: `identity-${member.id}-${provider}`,
              label: provider === "slack" ? "Slack user ID" : "GitHub username",
              value: link?.externalId ?? "",
              maxLength: provider === "slack" ? 100 : 39,
              status: unavailable
                ? "Connect Slack to match accounts."
                : link
                  ? `${link.status} · ${link.method}`
                  : "Unlinked",
              disabled: unavailable,
            }),
          );
          const input = form.querySelector<HTMLInputElement>("input")!;
          const status = form.querySelector<HTMLElement>("[data-identity-status]")!;
          const save = form.querySelector<HTMLButtonElement>("button")!;
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            save.disabled = true;
            void (async () => {
              try {
                const result = await fetch("/api/workspaces/identity-links", {
                  method: "PUT",
                  headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
                  body: JSON.stringify({
                    userId: member.id,
                    provider,
                    externalId: input.value.trim() || null,
                  }),
                });
                const body = (await result.json()) as { error?: string };
                if (!result.ok) throw new Error(body.error ?? "Account link could not be saved.");
                status.textContent = input.value.trim()
                  ? "linked · manual"
                  : provider === "slack"
                    ? "unmatched · email"
                    : "unmatched · manual";
                feedback.textContent = "Account link saved.";
              } catch (error) {
                journalCaught(error, "workspace-identities.load.fetch", null);
                feedback.textContent =
                  error instanceof Error ? error.message : "Account link could not be saved.";
              } finally {
                save.disabled = false;
              }
            })();
          });
          list.append(form);
        }
      }
    } catch (error) {
      journalCaught(error, "workspace-identities.load.fetch", null);
      feedback.textContent =
        error instanceof Error ? error.message : "Account links could not be loaded.";
    }
  }
}
