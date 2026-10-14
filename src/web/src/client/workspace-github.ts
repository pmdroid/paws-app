import { renderMarkup } from "./theme";
import { esc } from "./format";
import { initializeGitHubRepositorySetup } from "./github-repository-setup";
import { githubUrl } from "./github-url";

type GitHubStatus = {
  status:
    | "setup_required"
    | "needs_repositories"
    | "needs_installation"
    | "needs_access"
    | "needs_connection"
    | "connected";
  canManage: boolean;
  requiresSignIn: boolean;
  installationUrl?: string;
  repositoryCount?: number;
};

export function initializeWorkspaceGitHub(
  root: HTMLElement,
  csrfToken: string,
  canEditRepositories = false,
): void {
  if (canEditRepositories) {
    initializeGitHubRepositorySetup(root, csrfToken);
    return;
  }
  const section = document.createElement("section");
  section.id = "workspace-github-integration";
  section.dataset.settingsPage = "integrations";
  section.className = "settings-section";
  renderMarkup(
    section,
    '<div><h2>GitHub</h2><p class="sub">Open pull requests for work delegated in Linear.</p></div><div class="settings-account"><div data-github-status role="status" aria-live="polite">Checking connection…</div><p data-github-description></p><p data-github-feedback role="alert"></p><div data-github-actions class="row"></div></div>',
  );
  root.append(section);
  const status = section.querySelector<HTMLElement>("[data-github-status]")!;
  const description = section.querySelector<HTMLElement>("[data-github-description]")!;
  const feedback = section.querySelector<HTMLElement>("[data-github-feedback]")!;
  const actions = section.querySelector<HTMLElement>("[data-github-actions]")!;
  let data: GitHubStatus | null = null;
  let pending = false;
  let waitingForInstall = false;

  function paint() {
    if (!data) return;
    const labels: Record<GitHubStatus["status"], string> = {
      setup_required: "Setup needed",
      needs_repositories: "No repositories",
      needs_installation: "Not installed",
      needs_access: "Access needed",
      needs_connection: "Ready to connect",
      connected: "Connected",
    };
    renderMarkup(
      status,
      `<span class="pill ${data.status === "connected" ? "ok" : "warn"}">${labels[data.status]}</span>`,
    );
    description.textContent =
      data.status === "connected"
        ? `Available for ${data.repositoryCount ?? 0} ${(data.repositoryCount ?? 0) === 1 ? "repository" : "repositories"}.`
        : data.status === "setup_required"
          ? "Ask your Paws operator to finish GitHub setup."
          : data.status === "needs_repositories"
            ? canEditRepositories
              ? "Add the repositories Paws can work on for your Linear teams."
              : "Ask a workspace owner to add repositories in Workspace access."
            : !data.canManage
              ? "Ask a workspace admin to install and connect the GitHub App."
              : data.requiresSignIn
                ? "Sign in again to manage the GitHub connection."
                : data.status === "needs_connection"
                  ? "Approve GitHub access once. Paws handles the connection details."
                  : "Install the App on your workspace repositories, then return here to finish connecting.";
    let primary =
      data.status === "needs_repositories" && canEditRepositories
        ? '<a class="btn primary" href="#/settings/workspace">Add repositories</a>'
        : "";
    if (
      data.canManage &&
      !["connected", "setup_required", "needs_repositories"].includes(data.status)
    ) {
      if (data.requiresSignIn)
        primary = '<a class="btn primary" href="/auth/linear" data-github-signin>Sign in again</a>';
      else if (data.status === "needs_connection")
        primary =
          '<button class="btn primary" type="button" data-github-connect>Connect GitHub</button>';
      else if (data.installationUrl)
        primary = `<a class="btn primary" href="${esc(githubUrl(data.installationUrl, "install"))}" target="_blank" rel="noopener noreferrer" data-github-install>${data.status === "needs_access" ? "Review GitHub access" : "Install GitHub App"}</a>`;
    }
    const manage =
      data.status === "connected" && data.canManage && data.installationUrl
        ? `<a href="${esc(githubUrl(data.installationUrl, "install"))}" target="_blank" rel="noopener noreferrer">Manage on GitHub</a>`
        : "";
    renderMarkup(
      actions,
      `${primary}${manage}<button class="btn" type="button" data-github-refresh>Refresh status</button>`,
    );
  }

  async function load(): Promise<void> {
    if (pending) return;
    pending = true;
    feedback.textContent = "";
    for (const button of actions.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = true;
    try {
      const response = await fetch("/api/workspaces/github-connect", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | (GitHubStatus & { error?: string })
        | null;
      if (
        !response.ok ||
        !body ||
        ![
          "setup_required",
          "needs_repositories",
          "needs_installation",
          "needs_access",
          "needs_connection",
          "connected",
        ].includes(body.status)
      )
        throw new Error(body?.error ?? "GitHub could not be checked. Refresh status to try again.");
      data = body;
      paint();
    } catch (error) {
      renderMarkup(status, "<span>Connection unavailable</span>");
      feedback.textContent =
        error instanceof Error ? error.message : "GitHub could not be checked. Try again.";
      renderMarkup(
        actions,
        '<button class="btn" type="button" data-github-refresh>Refresh status</button>',
      );
    } finally {
      pending = false;
    }
  }

  async function connect(): Promise<void> {
    if (pending) return;
    pending = true;
    feedback.textContent = "";
    for (const button of actions.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = true;
    try {
      const response = await fetch("/api/workspaces/github-connect", {
        method: "POST",
        headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as {
        authorizationUrl?: string;
        installationUrl?: string;
        error?: string;
        code?: string;
      } | null;
      if (!response.ok || !body) {
        if (body?.code === "reauth_required" && data) {
          data.requiresSignIn = true;
          paint();
        }
        throw new Error(body?.error ?? "GitHub could not connect. Refresh status and try again.");
      }
      if (body.authorizationUrl)
        window.location.assign(githubUrl(body.authorizationUrl, "authorize"));
      else if (body.installationUrl && data) {
        data.status = "needs_installation";
        data.installationUrl = body.installationUrl;
        paint();
      } else throw new Error("GitHub could not connect. Refresh status and try again.");
    } catch (error) {
      feedback.textContent =
        error instanceof Error ? error.message : "GitHub could not connect. Try again.";
    } finally {
      pending = false;
      for (const button of actions.querySelectorAll<HTMLButtonElement>("button"))
        button.disabled = false;
    }
  }

  section.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-github-refresh], [data-github-connect], [data-github-signin], [data-github-install]",
    );
    if (!target) return;
    if (target.hasAttribute("data-github-signin")) {
      try {
        sessionStorage.setItem("paws.settingsReturn", "#/settings/integrations");
      } catch {}
    }
    if (target.hasAttribute("data-github-install")) waitingForInstall = true;
    if (target.hasAttribute("data-github-refresh")) void load();
    if (target.hasAttribute("data-github-connect")) void connect();
  });
  window.addEventListener("focus", () => {
    if (!section.isConnected || section.hidden || root.hidden) return;
    void load().then(() => {
      if (
        waitingForInstall &&
        data?.status === "needs_connection" &&
        data.canManage &&
        !data.requiresSignIn
      ) {
        waitingForInstall = false;
        void connect();
      }
    });
  });
  document.addEventListener("paws:github-access-changed", () => {
    if (section.isConnected) void load();
  });
  void load();
}
