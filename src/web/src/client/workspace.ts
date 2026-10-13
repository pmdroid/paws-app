import { initializeWorkspaceIdentities } from "./workspace-identities";
import { initializeWorkspaceAudit } from "./workspace-audit";
import { initializeWorkspaceGitHub } from "./workspace-github";
import { initializeWorkspaceAttribution } from "./workspace-attribution";

type BrowserSession = {
  role: string;
  workspaceId: string;
  csrfToken: string;
  workspaces: { id: string; name: string; role: string }[];
};

export async function initializeWorkspaceAccess(): Promise<boolean> {
  const root = document.querySelector<HTMLElement>("#workspace-access");
  let response: Response;
  try {
    response = await fetch("/api/auth/session", { cache: "no-store" });
  } catch {
    if (root !== null) {
      root.hidden = false;
      root.textContent = "Paws could not be reached. Reload to try again.";
    }
    return false;
  }
  if (response.status === 404) return true;
  if (response.status === 401) {
    document.body.classList.add("paws-login");
    const content = document.querySelector("#content");
    if (content !== null)
      content.innerHTML = `<section class="login-panel"><h1>Sign in to Paws</h1><p class="muted">Use your Linear account to open your workspace.</p><a class="btn primary" href="/auth/linear">Sign in with Linear</a><details><summary>Set up your first workspace</summary><form action="/auth/linear" method="post"><label class="field"><span>Setup code from the Paws operator</span><input name="bootstrap" required autocomplete="off" pattern="[A-Za-z0-9_-]{43}" /></label><button class="btn" type="submit">Connect workspace</button></form></details></section>`;
    if (root !== null) root.hidden = true;
    return false;
  }
  if (!response.ok) {
    if (root !== null) {
      root.hidden = false;
      root.innerHTML =
        '<p role="status">Workspace access could not be checked. Reload to try again.</p><button class="btn" id="workspace-signout">Sign out</button>';
      root.querySelector("#workspace-signout")?.addEventListener("click", () => {
        const csrf =
          document.querySelector('meta[name="paws-csrf"]')?.getAttribute("content") ?? "";
        void signOut(csrf).catch(() => {
          root.querySelector("p")!.textContent = "Sign-out failed. Reload to try again.";
        });
      });
    }
    return false;
  }
  const session = (await response.json()) as BrowserSession;
  document.body.classList.remove("paws-login");
  const csrf = document.querySelector('meta[name="paws-csrf"]');
  csrf?.setAttribute("content", session.csrfToken);
  if (root === null) return true;
  root.hidden = false;
  root.innerHTML = `<div class="row"><span>${escapeHtml(session.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name ?? "Workspace")}</span><span class="muted">${escapeHtml(session.role)}</span><button class="btn" id="workspace-signout">Sign out</button></div><p id="workspace-feedback" role="status"></p>${session.role === "owner" ? '<details id="workspace-members"><summary>Workspace access</summary><h2>Members</h2><div id="workspace-members-list"></div><h2>Repositories</h2><p class="muted">Match each repository to the Linear team that can access its work.</p><form id="workspace-repositories"><label class="field"><span>Repository and Linear team ID, one pair per line</span><textarea name="repositories" rows="4" placeholder="owner/repository team-id"></textarea></label><button class="btn" type="submit">Save repositories</button></form></details>' : ""}`;
  async function change(path: string, method: string, body?: unknown) {
    const result = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.ok) {
      const data = (await result.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "The change could not be saved. Try again.");
    }
  }
  async function report(action: () => Promise<void>) {
    const feedback = root!.querySelector("#workspace-feedback");
    try {
      await action();
    } catch (error) {
      if (feedback !== null)
        feedback.textContent =
          error instanceof Error ? error.message : "The change could not be saved.";
    }
  }
  root.querySelector("#workspace-signout")?.addEventListener(
    "click",
    () =>
      void report(async () => {
        await signOut(session.csrfToken);
      }),
  );
  if (session.role === "owner") {
    const [members, repositories] = await Promise.all([
      fetch("/api/workspaces/members", { cache: "no-store" }),
      fetch("/api/workspaces/repositories", { cache: "no-store" }),
    ]).catch(() => [null, null]);
    if (members?.ok) {
      const data = (await members.json()) as {
        members: { id: string; name: string; role: string; active: number }[];
      };
      const list = root.querySelector("#workspace-members-list");
      if (list !== null) {
        list.innerHTML = data.members
          .map(
            (member) =>
              `<form class="row workspace-member" data-member="${escapeHtml(member.id)}"><span>${escapeHtml(member.name)}${member.active ? "" : " (removed)"}</span><label><span class="sr-only">Role for ${escapeHtml(member.name)}</span><select name="role"${member.active ? "" : " disabled"}>${["owner", "admin", "member", "observer"].map((role) => `<option${role === member.role ? " selected" : ""}>${role}</option>`).join("")}</select></label><button class="btn" type="submit"${member.active ? "" : " disabled"}>Save role</button></form>`,
          )
          .join("");
        for (const form of list.querySelectorAll<HTMLFormElement>("form"))
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const button = form.querySelector<HTMLButtonElement>("button")!;
            button.disabled = true;
            void report(async () => {
              await change("/api/workspaces/members", "PUT", {
                userId: form.dataset.member,
                role: new FormData(form).get("role"),
              });
              const feedback = root!.querySelector("#workspace-feedback");
              if (feedback !== null) feedback.textContent = "Workspace role saved.";
            }).finally(() => {
              button.disabled = false;
            });
          });
      }
    }
    const repositoryForm = root.querySelector<HTMLFormElement>("#workspace-repositories");
    if (repositories?.ok && repositoryForm !== null) {
      const data = (await repositories.json()) as {
        repositories: { repository: string; teamId: string }[];
      };
      const input = repositoryForm.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = data.repositories
        .map((entry) => `${entry.repository} ${entry.teamId}`)
        .join("\n");
      repositoryForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const button = repositoryForm.querySelector<HTMLButtonElement>("button")!;
        button.disabled = true;
        void report(async () => {
          const entries = input.value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const mapped = entries.map((line) => {
            const parts = line.split(/\s+/);
            if (parts.length !== 2)
              throw new Error("Enter a repository and its Linear team ID on each line.");
            return { repository: parts[0], teamId: parts[1] };
          });
          await change("/api/workspaces/repositories", "PUT", { repositories: mapped });
          const feedback = root!.querySelector("#workspace-feedback");
          if (feedback !== null) feedback.textContent = "Repository access saved.";
        }).finally(() => {
          button.disabled = false;
        });
      });
    } else if (repositoryForm !== null) {
      repositoryForm.querySelector("button")?.setAttribute("disabled", "");
      const feedback = root.querySelector("#workspace-feedback");
      if (feedback !== null)
        feedback.textContent = "Workspace settings could not be loaded. Reload to try again.";
    }
  }
  if (["owner", "admin", "member"].includes(session.role))
    initializeWorkspaceAttribution(root, session.csrfToken);
  if (["owner", "admin"].includes(session.role)) {
    initializeWorkspaceGitHub(root, session.csrfToken);
    await initializeWorkspaceIdentities(root, session.csrfToken);
    initializeWorkspaceAudit(root);
  }
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function signOut(csrfToken: string) {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "x-paws-csrf": csrfToken },
  });
  if (!response.ok) throw new Error("Sign-out failed. Reload to try again.");
  location.reload();
}
