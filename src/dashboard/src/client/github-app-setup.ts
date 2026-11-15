import { esc } from "./format";
import { renderMarkup } from "./theme";

export async function initializeGitHubAppSetup(
  root: HTMLElement,
  csrfToken: string,
  proceed: () => void,
) {
  const section = document.createElement("section");
  section.className = "settings-section";
  section.dataset.settingsPage = "integrations";
  root.append(section);
  async function load() {
    const response = await fetch("/api/workspaces/github-app", { cache: "no-store" });
    if (!response.ok) throw new Error("GitHub setup could not be checked. Try again.");
    const data = (await response.json()) as {
      configured: boolean;
      canManage: boolean;
      webhookUrl: string;
      permissions: Record<string, string>;
      events: string[];
    };
    if (data.configured) {
      section.remove();
      proceed();
      return;
    }
    renderMarkup(
      section,
      `<div><h2>Configure the GitHub App</h2><p class="sub">Enter the credentials from your GitHub App settings.</p></div><div class="settings-account w-full"><p>Webhook URL: <code class="break-all">${esc(data.webhookUrl)}</code></p><details><summary>Required permissions and events</summary><ul>${Object.entries(
        data.permissions,
      )
        .map(([name, access]) => `<li>${esc(name)}: ${esc(access)}</li>`)
        .join("")}</ul><p>Events: ${data.events.map(esc).join(", ")}</p></details>${
        data.canManage
          ? `<form class="flex min-w-0 flex-col gap-4" autocomplete="off">
      <label class="field"><span>App ID</span><input name="appId" inputmode="numeric" required /></label>
      <label class="field"><span>OAuth client ID</span><input name="clientId" required /></label>
      <label class="field"><span>OAuth client secret</span><input name="clientSecret" type="password" required /></label>
      <label class="field"><span>Private key PEM</span><textarea name="privateKeyPem" rows="6" spellcheck="false" required></textarea></label>
      <label class="field"><span>Or upload a private key</span><input name="keyFile" type="file" accept=".pem" /></label>
      <label class="field"><span>Webhook secret</span><input name="webhookSecret" type="password" required /></label>
      <p role="alert" data-error></p><button class="btn primary" type="submit">Save GitHub App</button>
    </form>`
          : "<p>Ask a workspace admin to configure the GitHub App.</p>"
      }</div>`,
    );
    const form = section.querySelector("form");
    if (!form) return;
    const pem = form.elements.namedItem("privateKeyPem") as HTMLTextAreaElement;
    const file = form.elements.namedItem("keyFile") as HTMLInputElement;
    const error = form.querySelector<HTMLElement>("[data-error]")!;
    file.addEventListener("change", () => {
      void (async () => {
        try {
          if (file.files?.[0]) {
            if (file.files[0].size > 12000)
              throw new Error("Choose a PEM file smaller than 12 KB.");
            pem.value = await file.files[0].text();
          }
        } catch (caught) {
          error.textContent = (caught as Error).message;
        }
      })();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        event.preventDefault();
        const button = form.querySelector("button")!;
        button.disabled = true;
        button.textContent = "Checking GitHub App…";
        error.textContent = "";
        try {
          const values = new FormData(form);
          const body = Object.fromEntries(
            ["appId", "clientId", "clientSecret", "privateKeyPem", "webhookSecret"].map((name) => [
              name,
              values.get(name),
            ]),
          );
          const saved = await fetch("/api/workspaces/github-app", {
            method: "POST",
            headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
            body: JSON.stringify(body),
          });
          if (!saved.ok) {
            const failure = await saved.json();
            throw new Error(failure.error ?? "GitHub App could not be saved.");
          }
          form.reset();
          section.remove();
          proceed();
        } catch (caught) {
          error.textContent = (caught as Error).message;
          button.disabled = false;
          button.textContent = "Save GitHub App";
        }
      })();
    });
  }
  try {
    await load();
  } catch {
    renderMarkup(
      section,
      '<p role="alert">GitHub setup could not be checked.</p><button class="btn" type="button">Try again</button>',
    );
    section.querySelector("button")!.addEventListener("click", () => {
      section.remove();
      void initializeGitHubAppSetup(root, csrfToken, proceed);
    });
  }
}
