import { renderMarkup } from "./theme";

export function initializeWorkspaceAttribution(root: HTMLElement, csrfToken: string): void {
  const section = document.createElement("section");
  section.id = "workspace-github-attribution";
  section.dataset.settingsPage = "account";
  section.className = "settings-section";
  renderMarkup(
    section,
    '<div><h2>GitHub credit</h2><p class="sub">Link GitHub to credit you on commits and pull requests.</p></div><div class="settings-account"><p role="status">Loading your attribution…</p><form><label class="field"><span><input type="checkbox" name="consent" required /> I consent to public commit and pull request credit using my verified GitHub identity.</span></label><button class="btn" type="submit" disabled>Link GitHub identity</button></form><button class="btn" type="button" data-revoke hidden>Revoke attribution consent</button><button class="btn" type="button" data-refresh>Refresh attribution</button></div>',
  );
  root.append(section);
  const feedback = section.querySelector<HTMLElement>('[role="status"]')!;
  const connect = section.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const revoke = section.querySelector<HTMLButtonElement>("[data-revoke]")!;
  const refresh = section.querySelector<HTMLButtonElement>("[data-refresh]")!;
  const form = section.querySelector<HTMLFormElement>("form")!;
  async function request(method: string) {
    const response = await fetch("/api/workspaces/github-attribution", {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
      ...(method === "POST" ? { body: JSON.stringify({ consent: true }) } : {}),
    });
    const data = (await response.json().catch(() => null)) as {
      configured?: boolean;
      identity?: { login: string } | null;
      authorizeUrl?: string;
      error?: string;
    } | null;
    if (!response.ok || data === null)
      throw new Error(data?.error ?? "Attribution could not be checked. Try Refresh attribution.");
    return data;
  }
  async function load() {
    connect.disabled = true;
    revoke.hidden = true;
    refresh.disabled = true;
    try {
      const data = await request("GET");
      feedback.textContent = data.identity
        ? `Public attribution is enabled for @${data.identity.login}.`
        : data.configured === false
          ? "Ask the Paws operator to configure the GitHub App on the server, then restart Paws."
          : "No verified GitHub attribution. Link your identity to enable public credit.";
      form.hidden = Boolean(data.identity);
      revoke.hidden = !data.identity;
      connect.disabled = data.configured === false;
    } catch (error) {
      feedback.textContent =
        error instanceof Error
          ? error.message
          : "Paws could not be reached. Try Refresh attribution.";
    } finally {
      refresh.disabled = false;
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    connect.disabled = true;
    void (async () => {
      try {
        const data = await request("POST");
        const url = new URL(data.authorizeUrl ?? "");
        if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize")
          throw new Error("Invalid GitHub authorization redirect.");
        window.location.assign(url.href);
      } catch (error) {
        feedback.textContent =
          error instanceof Error ? error.message : "Linking failed. Try again.";
        connect.disabled = false;
      }
    })();
  });
  revoke.addEventListener("click", () => {
    revoke.disabled = true;
    void request("DELETE")
      .then(load)
      .catch((error: unknown) => {
        feedback.textContent =
          error instanceof Error ? error.message : "Revocation failed. Try again.";
      })
      .finally(() => {
        revoke.disabled = false;
      });
  });
  refresh.addEventListener("click", () => {
    void load();
  });
  void load();
}
