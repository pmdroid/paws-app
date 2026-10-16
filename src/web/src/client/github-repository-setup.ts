import { renderMarkup } from "./theme";
import { esc } from "./format";
import { githubUrl } from "./github-url";

type Mapping = { repository: string; teamId: string };
type Catalog = {
  signedIn: boolean;
  setupId?: string;
  login?: string;
  installations?: { id: string; account: string }[];
  installationId?: string | null;
  repositories?: { repository: string; private: boolean }[];
  teams?: { id: string; name: string; key: string }[];
  missingPermissions?: string[];
  mappings: Mapping[];
};

export function initializeGitHubRepositorySetup(root: HTMLElement, csrfToken: string) {
  const section = document.createElement("section");
  section.id = "workspace-github-integration";
  section.className = "settings-section";
  section.dataset.settingsPage = "integrations";
  renderMarkup(
    section,
    '<div><h2>GitHub</h2><p class="sub">Connect GitHub. Paws picks the repository from Linear\'s suggestion among those the app can access. Add repositories to a Linear team to limit that team to them.</p></div><div class="settings-account w-full"><p data-status role="status">Checking GitHub…</p><div class="row" data-actions></div><p data-feedback role="alert" class="empty:hidden"></p><div data-repository-editor class="w-full min-w-0"></div></div>',
  );
  root.append(section);
  const status = section.querySelector<HTMLElement>("[data-status]")!;
  const actions = section.querySelector<HTMLElement>("[data-actions]")!;
  const feedback = section.querySelector<HTMLElement>("[data-feedback]")!;
  const editor = section.querySelector<HTMLElement>("[data-repository-editor]")!;
  let catalog: Catalog | null = null;
  let requiresSignIn = false;
  let pending = false;
  let installationUrl: string | undefined;
  let waitingForInstall = false;
  let selection: Mapping[] = [];
  let page = 0;
  let search = "";

  function setControls(disabled: boolean) {
    for (const control of section.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >("input,button,select"))
      control.disabled = disabled;
    if (!disabled && catalog?.signedIn && editor.querySelector("form")) {
      if (editor.querySelector("[data-repository-rows]")) paintRows();
      else updateSelection();
    }
  }
  function paintActions() {
    renderMarkup(
      actions,
      `${requiresSignIn ? '<a class="btn primary" href="/auth/linear" data-signin>Sign in again</a>' : catalog?.signedIn ? '<button class="btn" type="button" data-login>Switch GitHub account</button>' : '<button class="btn primary" type="button" data-login>Sign in with GitHub</button>'}${catalog?.signedIn && installationUrl ? `<a class="btn" href="${esc(githubUrl(installationUrl, "install"))}" target="_blank" rel="noopener noreferrer" data-install>Choose repositories on GitHub</a>` : ""}<button class="btn" type="button" data-refresh>Refresh repositories</button>`,
    );
    for (const button of actions.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = pending;
  }
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
            body: JSON.stringify(body),
          }),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    if (!response.ok || !data) {
      if (
        data?.code === "reauth_required" ||
        data?.code === "owner_required" ||
        response.status === 401
      ) {
        requiresSignIn = true;
        catalog = null;
        renderMarkup(editor, "");
        paintActions();
      }
      throw new Error(
        data?.error ?? "GitHub could not be reached. Refresh repositories to try again.",
      );
    }
    return data;
  }
  function updateSelection() {
    const unavailable = unavailableMappings();
    renderMarkup(
      editor.querySelector<HTMLElement>("[data-unavailable]")!,
      unavailable.length
        ? `<p>Some saved access is unavailable to this GitHub account. Switch accounts or remove these entries before saving.</p><ul>${unavailable.map((entry) => `<li>${esc(entry.repository)} · ${esc(catalog?.teams?.find((team) => team.id === entry.teamId)?.name ?? entry.teamId)}</li>`).join("")}</ul><button class="btn" type="button" data-remove-unavailable${pending ? " disabled" : ""}>Remove unavailable repository access</button>`
        : "",
    );
    editor.querySelector<HTMLElement>("[data-selection]")!.textContent =
      new Set(selection.map((entry) => entry.repository)).size + " repositories selected";
    const button = editor.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const removing = selection.length === 0 && (catalog?.mappings.length ?? 0) > 0;
    button.textContent = removing ? "Remove all repository access" : "Save repository access";
    button.disabled =
      pending ||
      unavailable.length > 0 ||
      (catalog?.missingPermissions?.length ?? 0) > 0 ||
      (selection.length === 0 && !removing);
  }
  function unavailableMappings() {
    return selection.filter(
      (entry) =>
        !catalog?.repositories?.some((repo) => repo.repository === entry.repository) ||
        !catalog.teams?.some((team) => team.id === entry.teamId),
    );
  }
  function paintRows() {
    if (!catalog?.signedIn) return;
    const rows = editor.querySelector<HTMLElement>("[data-repository-rows]")!;
    const repositories = (catalog.repositories ?? []).filter((entry) =>
      entry.repository.includes(search.toLowerCase()),
    );
    const lastPage = Math.max(0, Math.ceil(repositories.length / 25) - 1);
    page = Math.min(page, lastPage);
    renderMarkup(
      rows,
      `<table aria-label="GitHub repositories"><thead><tr><th scope="col">Repository</th><th scope="col">Linear teams</th></tr></thead><tbody>${repositories
        .slice(page * 25, page * 25 + 25)
        .map(
          (repo) =>
            `<tr><td><strong>${esc(repo.repository)}</strong><p class="sub">${repo.private ? "Private" : "Public"}</p></td><td><fieldset class="flex flex-wrap gap-3"><legend class="sr-only">Linear teams for ${esc(repo.repository)}</legend>${(catalog!.teams ?? []).map((team) => `<label class="flex items-center gap-2"><input type="checkbox" name="mapping" data-repository="${esc(repo.repository)}" value="${esc(team.id)}" aria-label="Match ${esc(repo.repository)} to ${esc(team.name)}"${selection.some((entry) => entry.repository === repo.repository && entry.teamId === team.id) ? " checked" : ""} /><span>${esc(team.name)} (${esc(team.key)})</span></label>`).join("")}</fieldset></td></tr>`,
        )
        .join("")}</tbody></table>`,
    );
    editor.querySelector<HTMLElement>("[data-page]")!.textContent = repositories.length
      ? `${page * 25 + 1}–${Math.min((page + 1) * 25, repositories.length)} of ${repositories.length} repositories`
      : "No matching repositories.";
    editor.querySelector<HTMLButtonElement>("[data-previous]")!.disabled = page === 0;
    editor.querySelector<HTMLButtonElement>("[data-next]")!.disabled = page === lastPage;
    updateSelection();
  }
  function paintEditor() {
    if (!catalog?.signedIn || requiresSignIn) {
      renderMarkup(editor, "");
      return;
    }
    const repositories = catalog.repositories ?? [];
    const teams = catalog.teams ?? [];
    const permissionNames: Record<string, string> = {
      contents: "Contents",
      pull_requests: "Pull requests",
      checks: "Checks",
      issues: "Issues",
    };
    const missing = catalog.missingPermissions ?? [];
    renderMarkup(
      editor,
      `<form class="flex min-w-0 flex-col gap-4">${missing.length ? `<div role="alert"><p>The Paws GitHub App needs Read and write access to: ${missing.map((permission) => esc(permissionNames[permission] ?? permission)).join(", ")}.</p><p>Ask the Paws operator to update the App permissions, then approve the update on GitHub and refresh repositories.</p><a class="btn" href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Review GitHub App permissions</a></div>` : ""}<p>Signed in as <strong>@${esc(catalog.login ?? "")}</strong></p>${(catalog.installations?.length ?? 0) ? `<label class="field"><span>GitHub account</span><select name="installationId">${catalog.installations!.map((installation) => `<option value="${esc(installation.id)}"${installation.id === catalog!.installationId ? " selected" : ""}>${esc(installation.account)}</option>`).join("")}</select></label>` : ""}${repositories.length && teams.length ? '<label class="field"><span>Find a repository</span><input type="search" name="repositorySearch" placeholder="Search repositories" /></label><p class="sub">Select the Linear teams that can use each repository.</p><div data-repository-rows role="region" aria-label="Repository choices" tabindex="0" class="max-h-[28rem] overflow-auto"></div><div class="row"><button class="btn" type="button" data-previous>Previous</button><span data-page></span><button class="btn" type="button" data-next>Next</button></div>' : `<p>${!catalog.installations?.length ? "Give the Paws App access to your GitHub repositories, then refresh this list." : !repositories.length ? "Choose repositories the App can access on GitHub, then refresh this list." : "Ask your Linear administrator to give Paws access to a team, then refresh this list."}</p>`}<div data-unavailable role="status" class="flex flex-col gap-3 empty:hidden"></div><p data-selection role="status"></p><button class="btn primary" type="submit">Save repository access</button></form>`,
    );
    if (repositories.length && teams.length) paintRows();
    else updateSelection();
  }
  async function load(selected?: string) {
    if (pending) return;
    pending = true;
    setControls(true);
    feedback.textContent = "";
    paintActions();
    try {
      const healthResponse = await fetch("/api/workspaces/github-connect", { cache: "no-store" });
      const health = (await healthResponse.json().catch(() => null)) as {
        status?: string;
        requiresSignIn?: boolean;
        installationUrl?: string;
        repositoryCount?: number;
        error?: string;
      } | null;
      if (!healthResponse.ok || !health)
        throw new Error(
          health?.error ?? "GitHub could not be checked. Refresh repositories to try again.",
        );
      if (health.status === "setup_required") {
        catalog = null;
        renderMarkup(actions, "");
        renderMarkup(editor, "");
        status.textContent = "Ask your Paws operator to finish GitHub setup.";
        return;
      }
      installationUrl = health.installationUrl;
      requiresSignIn = health.requiresSignIn === true;
      if (requiresSignIn) {
        catalog = null;
        renderMarkup(editor, "");
        status.textContent = "Sign in again to manage GitHub repositories.";
      } else {
        catalog = (await request(
          `/api/workspaces/github-setup${selected ? `?installationId=${encodeURIComponent(selected)}` : ""}`,
        )) as unknown as Catalog;
        if (!selected && catalog.mappings.length) {
          const account = catalog.installations?.find(
            (installation) =>
              installation.account.toLowerCase() ===
              catalog!.mappings[0]!.repository.split("/")[0]!.toLowerCase(),
          );
          if (account && account.id !== catalog.installationId)
            catalog = (await request(
              "/api/workspaces/github-setup?installationId=" + encodeURIComponent(account.id),
            )) as unknown as Catalog;
        }
        selection = structuredClone(catalog.mappings);
        page = 0;
        search = "";
        status.textContent =
          health.status === "connected"
            ? `Connected · ${health.repositoryCount ?? 0} repositories available to Paws.`
            : catalog.signedIn
              ? "Choose repositories and match them to Linear teams."
              : "Sign in with GitHub to choose your repositories.";
        paintEditor();
      }
      paintActions();
    } catch (error) {
      status.textContent = "GitHub connection unavailable.";
      feedback.textContent =
        error instanceof Error ? error.message : "GitHub could not be reached.";
      paintActions();
    } finally {
      pending = false;
      setControls(false);
    }
  }
  section.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-login],[data-signin],[data-refresh],[data-install],[data-next],[data-previous]",
    );
    if (!target) return;
    if (target.hasAttribute("data-signin")) {
      try {
        sessionStorage.setItem("paws.settingsReturn", "#/settings/integrations");
      } catch {}
    }
    if (target.hasAttribute("data-install")) waitingForInstall = true;
    if (target.hasAttribute("data-refresh")) void load(catalog?.installationId ?? undefined);
    if (target.hasAttribute("data-next")) {
      page++;
      paintRows();
    }
    if (target.hasAttribute("data-previous")) {
      page--;
      paintRows();
    }
    if (target.hasAttribute("data-login") && !pending) {
      pending = true;
      setControls(true);
      paintActions();
      void request("/api/workspaces/github-setup", "POST", {})
        .then((body) => {
          window.location.assign(
            githubUrl((body as { authorizationUrl?: string }).authorizationUrl ?? "", "authorize"),
          );
        })
        .catch((error: unknown) => {
          feedback.textContent =
            error instanceof Error ? error.message : "GitHub sign-in could not start.";
        })
        .finally(() => {
          pending = false;
          paintActions();
          setControls(false);
        });
    }
  });
  editor.addEventListener("click", (event) => {
    if (pending || !(event.target as Element).closest("[data-remove-unavailable]")) return;
    const unavailable = unavailableMappings();
    selection = selection.filter((entry) => !unavailable.includes(entry));
    updateSelection();
  });
  editor.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "repositorySearch") {
      search = target.value;
      page = 0;
      paintRows();
    }
  });
  editor.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "installationId") void load(target.value);
    if (target.name === "mapping") {
      selection = selection.filter(
        (entry) => entry.repository !== target.dataset.repository || entry.teamId !== target.value,
      );
      if (target.checked)
        selection.push({ repository: target.dataset.repository!, teamId: target.value });
      updateSelection();
    }
  });
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      pending ||
      !catalog?.installationId ||
      unavailableMappings().length ||
      catalog.missingPermissions?.length
    )
      return;
    const installationId = catalog.installationId;
    const setupId = catalog.setupId;
    const mappings = structuredClone(selection);
    pending = true;
    feedback.textContent = "Saving repository access…";
    setControls(true);
    void request("/api/workspaces/github-setup", "PUT", { installationId, mappings, setupId })
      .then(async () => {
        pending = false;
        await load(installationId);
        feedback.textContent = "Repository access saved.";
        document.dispatchEvent(new Event("paws:github-access-changed"));
      })
      .catch((error: unknown) => {
        feedback.textContent =
          error instanceof Error ? error.message : "Repository access could not be saved.";
      })
      .finally(() => {
        pending = false;
        setControls(false);
      });
  });
  window.addEventListener("focus", () => {
    if (waitingForInstall && section.isConnected && !section.hidden && !root.hidden) {
      waitingForInstall = false;
      void load();
    }
  });
  void load();
}
