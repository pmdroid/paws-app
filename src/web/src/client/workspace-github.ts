import { renderMarkup } from "./theme";

export function initializeWorkspaceGitHub(root: HTMLElement, csrfToken: string): void {
  const section = document.createElement("details");
  section.id = "workspace-github-integration";
  renderMarkup(
    section,
    '<summary>Workspace GitHub App</summary><p>Repository work uses the workspace App installation, not a member’s personal GitHub credentials. Optional GitHub username mappings identify people; they do not grant repository access.</p><form><label class="field"><span>GitHub App installation ID</span><input name="installationId" inputmode="numeric" pattern="[1-9][0-9]*" required autocomplete="off" /></label><button class="btn" type="submit">Connect or reconnect GitHub App</button></form><p>After restoring the configured installation and approved repository permissions on GitHub, revalidate access to resume waiting work safely.</p><button class="btn" type="button">Revalidate GitHub App</button><p role="status"></p>',
  );
  root.append(section);
  const button = section.querySelector<HTMLButtonElement>("button[type=button]")!;
  const feedback = section.querySelector<HTMLElement>('[role="status"]')!;
  section.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const connect = form.querySelector<HTMLButtonElement>("button")!;
    connect.disabled = true;
    void (async () => {
      try {
        const response = await fetch("/api/workspaces/github-connect", {
          method: "POST",
          headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
          body: JSON.stringify({ installationId: new FormData(form).get("installationId") }),
        });
        const data = (await response.json()) as { authorizationUrl?: string; error?: string };
        if (!response.ok || !data.authorizationUrl)
          throw new Error(data.error ?? "Connection could not start.");
        const url = new URL(data.authorizationUrl);
        if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize")
          throw new Error("Invalid GitHub authorization redirect.");
        window.location.assign(url.href);
      } catch (error) {
        feedback.textContent =
          error instanceof Error ? error.message : "Connection could not start.";
        connect.disabled = false;
      }
    })();
  });
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Revalidating…";
    feedback.textContent = "";
    void (async () => {
      try {
        const response = await fetch("/api/workspaces/github-integration", {
          method: "POST",
          headers: { "x-paws-csrf": csrfToken },
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(data.error ?? "GitHub App access could not be checked. Try again.");
        feedback.textContent =
          "GitHub App access verified. Waiting tasks will be revalidated before continuing.";
      } catch (error) {
        feedback.textContent =
          error instanceof Error ? error.message : "Paws could not be reached. Try again.";
      } finally {
        button.disabled = false;
        button.textContent = "Revalidate GitHub App";
      }
    })();
  });
}
