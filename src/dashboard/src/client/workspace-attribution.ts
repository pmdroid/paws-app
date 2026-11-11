import { journalCaught } from "../journal";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";

export function initializeWorkspaceAttribution(root: HTMLElement, csrfToken: string): void {
  const section = document.createElement("section");
  section.id = "workspace-github-attribution";
  section.dataset.settingsPage = "account";
  section.className = "settings-section";
  renderMarkup(
    section,
    '<div><h2>GitHub credit</h2><p class="sub">Link GitHub to credit you on commits and pull requests.</p></div><div class="settings-account"><p role="status">Loading your attribution…</p><form><label class="field"><span><input type="checkbox" name="consent" required /> I consent to public commit and pull request credit using my verified GitHub identity.</span></label><button class="btn" type="submit" disabled>Link GitHub identity</button></form><label class="field" data-as-member hidden><span><input type="checkbox" name="pullRequestsAsMember" /> Open pull requests as me. Paws keeps your GitHub authorization to open them for you.</span></label><button class="btn" type="button" data-revoke hidden>Revoke attribution consent</button><button class="btn" type="button" data-refresh>Refresh attribution</button></div>',
  );
  root.append(section);
  const feedback = section.querySelector<HTMLElement>('[role="status"]')!;
  const connect = section.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const revoke = section.querySelector<HTMLButtonElement>("[data-revoke]")!;
  const refresh = section.querySelector<HTMLButtonElement>("[data-refresh]")!;
  const form = section.querySelector<HTMLFormElement>("form")!;
  const consent = form.querySelector<HTMLInputElement>('input[name="consent"]')!;
  const asMemberField = section.querySelector<HTMLElement>("[data-as-member]")!;
  const asMember = asMemberField.querySelector<HTMLInputElement>("input")!;
  let canLink = false;
  consent.addEventListener("change", () => {
    connect.disabled = !canLink || !consent.checked;
  });
  async function request(method: string, body?: Record<string, boolean>) {
    const response = await fetch("/api/workspaces/github-attribution", {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch((caughtError1) => {
      journalCaught(caughtError1, "workspace-attribution.request.json", null);
      return null;
    })) as {
      configured?: boolean;
      identity?: { login: string } | null;
      authorizeUrl?: string;
      pullRequestsAsMember?: { available: boolean; enabled: boolean };
      error?: string;
    } | null;
    if (!response.ok || data === null) {
      throw new Error(data?.error ?? "Attribution could not be checked. Try Refresh attribution.");
    }
    return data;
  }
  async function load() {
    canLink = false;
    connect.disabled = true;
    revoke.hidden = true;
    refresh.disabled = true;
    try {
      const data = await request("GET");
      feedback.textContent = data.identity
        ? `Public attribution is enabled for @${data.identity.login}.`
        : data.configured === false
          ? "Ask the Paws operator to configure the GitHub App on the server, then restart Paws."
          : "No verified GitHub attribution. Select the consent checkbox to link your account.";
      form.hidden = Boolean(data.identity);
      revoke.hidden = !data.identity;
      canLink = data.configured !== false;
      connect.disabled = !canLink || !consent.checked;
      asMemberField.hidden = data.pullRequestsAsMember?.available !== true;
      if (data.identity) form.after(asMemberField);
      else form.insertBefore(asMemberField, connect);
      asMember.checked = data.pullRequestsAsMember?.enabled === true;
    } catch (error) {
      journalCaught(error, "workspace-attribution.load.request", null);
      feedback.textContent =
        error instanceof Error
          ? error.message
          : "Paws could not be reached. Try Refresh attribution.";
    } finally {
      refresh.disabled = false;
    }
  }
  async function authorize(pullRequestsAsMember: boolean) {
    const data = await request("POST", { consent: true, pullRequestsAsMember });
    const url = new URL(data.authorizeUrl ?? "");
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize")
      throw new Error("Invalid GitHub authorization redirect.");
    window.location.assign(url.href);
  }
  asMember.addEventListener("change", () => {
    if (revoke.hidden) return;
    asMember.disabled = true;
    void (
      asMember.checked
        ? authorize(true)
        : request("POST", { pullRequestsAsMember: false }).then(load)
    )
      .catch((error: unknown) => {
        journalCaught(error, "workspace-attribution.asMember.change", null);
        asMember.checked = !asMember.checked;
        feedback.textContent = error instanceof Error ? error.message : "Saving failed. Try again.";
      })
      .finally(() => {
        asMember.disabled = false;
      });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    connect.disabled = true;
    void (async () => {
      try {
        await authorize(asMember.checked);
      } catch (error) {
        journalCaught(error, "workspace-attribution.initializeWorkspaceAttribution.request", null);
        feedback.textContent =
          error instanceof Error ? error.message : "Linking failed. Try again.";
        connect.disabled = !canLink || !consent.checked;
      }
    })();
  });
  revoke.addEventListener("click", () => {
    revoke.disabled = true;
    void request("DELETE")
      .then(load)
      .catch((error: unknown) => {
        journalCaught(error, "workspace-attribution.initializeWorkspaceAttribution.then", null);
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
  loadWhenShown("account", () => void load());
}
