type IdentityLink = {
  userId: string;
  provider: string;
  externalId: string | null;
  method: string;
  status: string;
};

export async function initializeWorkspaceIdentities(root: HTMLElement, csrfToken: string) {
  const details = document.createElement("details");
  details.innerHTML =
    '<summary>Account links</summary><p class="muted">Slack matches use the email in Linear. You can also map accounts manually.</p><div class="workspace-identities"></div><p role="status"></p>';
  root.append(details);
  const feedback = details.querySelector<HTMLElement>('[role="status"]')!;
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
        form.className = "row workspace-member";
        const label = document.createElement("label");
        label.className = "field";
        const title = document.createElement("span");
        title.textContent = provider === "slack" ? "Slack user ID" : "GitHub username";
        const input = document.createElement("input");
        input.value = link?.externalId ?? "";
        input.autocomplete = "off";
        input.maxLength = provider === "slack" ? 100 : 39;
        const unavailable = provider === "slack" && data.slackTeamId === null;
        input.disabled = unavailable;
        label.append(title, input);
        const status = document.createElement("span");
        status.className = "muted";
        status.textContent = unavailable
          ? "Connect Slack to match accounts."
          : link
            ? `${link.status} · ${link.method}`
            : "Unlinked";
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "btn";
        save.textContent = "Save account";
        save.disabled = unavailable;
        form.append(label, status, save);
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
    feedback.textContent =
      error instanceof Error ? error.message : "Account links could not be loaded.";
  }
}
