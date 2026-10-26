import { journalCaught } from "../journal";
import { initializeDecisions } from "./decisions";
import type { SettingsPage } from "./settings-pages";
import { renderMarkup } from "./theme";
import { initializeWorkspaceIdentities } from "./workspace-identities";
import { initializeWorkspaceAudit } from "./workspace-audit";
import { initializeWorkspaceGitHub } from "./workspace-github";
import { initializeWorkspaceAttribution } from "./workspace-attribution";
import { routeHref } from "./route";
import { clearSettingsLoads, loadWhenShown, settingsPageShown } from "./settings-loads";

type BrowserSession = {
  role: string;
  user?: { name: string; email: string } | null;
  workspaceId: string;
  csrfToken: string;
  workspaces: { id: string; name: string; role: string }[];
};

const SIGN_IN_RETURN = "paws.signInReturn";

/** Sign-in always lands on the overview, so the page a signed-out reader opened is kept here. */
function rememberSignInReturn(): void {
  const path = `${location.pathname}${location.search}${location.hash}`;
  try {
    if (location.pathname.replace(/\/+$/, "") === "/status" || location.pathname === "/")
      sessionStorage.removeItem(SIGN_IN_RETURN);
    else sessionStorage.setItem(SIGN_IN_RETURN, path);
  } catch (caughtError1) {
    journalCaught(caughtError1, "workspace.rememberSignInReturn.replace", null);
  }
}

export function takeSignInReturn(): string | null {
  try {
    const path = sessionStorage.getItem(SIGN_IN_RETURN);
    sessionStorage.removeItem(SIGN_IN_RETURN);
    return path?.startsWith("/") && !path.startsWith("//") ? path : null;
  } catch (caughtError2) {
    journalCaught(caughtError2, "workspace.takeSignInReturn.getItem", null);
    return null;
  }
}

export async function initializeWorkspaceAccess(page: () => SettingsPage | null): Promise<boolean> {
  const root = document.querySelector<HTMLElement>("#workspace-access");
  let response: Response;
  try {
    response = await fetch("/api/auth/session", { cache: "no-store" });
    for (
      let attempt = 0;
      response.status === 503 && location.search.includes("connecting=1") && attempt < 40;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await fetch("/api/auth/session", { cache: "no-store" });
    }
  } catch (caughtError3) {
    journalCaught(caughtError3, "workspace.initializeWorkspaceAccess.fetch", null);
    if (root !== null) {
      root.hidden = false;
      root.textContent = "Paws could not be reached. Reload to try again.";
    }
    return false;
  }
  if (response.status === 404) {
    if (root) {
      root.dataset.loaded = "true";
      renderMarkup(
        root,
        '<p data-settings-page="integrations">Configure workspace sign-in to manage service connections.</p><p data-settings-page="workspace">Configure workspace sign-in to manage members and repositories.</p><p data-settings-page="audit">Configure workspace sign-in to view workspace changes.</p>',
      );
    }
    return true;
  }
  if (response.status === 401) {
    const state = (await response.json().catch((caughtError4) => {
      journalCaught(caughtError4, "workspace.initializeWorkspaceAccess.json", null);
      return null;
    })) as {
      onboarding?: boolean;
      configured?: boolean;
      reconnect?: boolean;
    } | null;
    const onboarding = state?.onboarding === true;
    const reconnect = state?.reconnect === true;
    const configured = state?.configured !== false;
    const reason = new URLSearchParams(location.search).get("onboarding");
    const messages: Record<string, string> = {
      "admin-required":
        "A Linear workspace admin needs to authorize Paws. Sign in with an admin account to continue.",
      "workspace-mismatch":
        "Choose the same Linear workspace for sign-in and app authorization. Try again.",
      "already-connected": "This server is already connected. Sign in to open your workspace.",
      failed: "Linear authorization was not completed. Try again.",
    };
    const error = reason ? messages[reason] : undefined;
    document.body.classList.add("paws-login");
    setLoginLayout(true);
    const content = document.querySelector("#page-content");
    rememberSignInReturn();
    const evidence = /^(?:\/status)?\/evidence\/[^/]+\/?$/.test(location.pathname);
    const heading = reconnect
      ? "Reconnect Linear"
      : onboarding
        ? "Connect your workspace"
        : evidence
          ? "Sign in to view this evidence"
          : "Sign in to Paws";
    const lead = reconnect
      ? "Linear access was revoked. Sign in as a workspace admin and authorize Paws again to reconnect."
      : onboarding
        ? "Sign in with Linear, authorize Paws for your workspace, then connect GitHub and a runner. A Linear workspace admin needs to complete this first step."
        : evidence
          ? "Use your Linear account to see this Closeout video or screenshot. Paws opens this link again after you sign in."
          : "Use your Linear account to open your workspace.";
    if (content !== null)
      renderMarkup(
        content,
        `<section class="login-panel"><h1>${heading}</h1><p class="muted">${lead}</p>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}${configured ? '<a class="btn primary" href="/auth/linear">Sign in with Linear</a>' : '<p role="status">The Paws server needs its Linear app credentials. Ask the server operator to configure them, then reload this page.</p>'}</section>`,
      );
    if (root !== null) root.hidden = true;
    return false;
  }
  if (!response.ok) {
    if (root !== null) {
      root.hidden = false;
      renderMarkup(
        root,
        '<p role="status">Workspace access could not be checked. Reload to try again.</p><button class="btn" id="workspace-signout">Sign out</button>',
      );
      root.querySelector("#workspace-signout")?.addEventListener("click", () => {
        const csrf =
          document.querySelector('meta[name="paws-csrf"]')?.getAttribute("content") ?? "";
        void signOut(csrf).catch((caughtError5) => {
          journalCaught(caughtError5, "workspace.initializeWorkspaceAccess.signOut", null);
          root.querySelector("p")!.textContent = "Sign-out failed. Reload to try again.";
        });
      });
    }
    return false;
  }
  const session = (await response.json()) as BrowserSession;
  document.body.classList.remove("paws-login");
  setLoginLayout(false);
  const csrf = document.querySelector('meta[name="paws-csrf"]');
  csrf?.setAttribute("content", session.csrfToken);
  if (root === null) return true;
  clearSettingsLoads();
  root.hidden = false;
  root.dataset.loaded = "true";
  root.dataset.workspace = "true";
  root.className = "flex min-w-0 flex-col gap-8";
  renderMarkup(
    root,
    `<section data-settings-page="account" class="settings-section"><div><h2>Linear account</h2><p class="sub">You are signed in to ${escapeHtml(session.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name ?? "your workspace")}.</p></div><div class="settings-account"><strong>${escapeHtml(session.user?.name ?? "Linear account")}</strong>${session.user?.email ? `<span>${escapeHtml(session.user.email)}</span>` : ""}<span class="muted">Workspace role: ${escapeHtml(session.role)}</span><button class="btn" id="workspace-signout">Sign out</button></div></section><p id="workspace-feedback" class="empty:hidden" data-settings-page="workspace" role="status"></p>${linearConnectionMarkup(session.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name ?? "Workspace")}${session.role === "owner" ? '<section data-settings-page="workspace" id="workspace-members" class="settings-section"><div><h2>Members</h2><p class="sub">Choose who can manage and use this workspace.</p><button class="btn" type="button" data-members-refresh>Refresh members</button></div><div id="workspace-members-list"></div></section><section data-settings-page="workspace" class="settings-section"><div><h2>Repositories</h2><p class="sub">Give each Linear team access to its repositories.</p></div><div><p>Connect GitHub and match repositories to Linear teams in Integrations.</p><a class="btn" href="' + routeHref({ view: "settings", page: "integrations" }) + '">Manage GitHub repositories</a></div></section>' : '<p data-settings-page="workspace" class="sub">Ask a workspace owner to change members, roles, or repository access.</p>'}${!["owner", "admin"].includes(session.role) ? '<p data-settings-page="audit" class="sub">Audit history is available to workspace owners and admins.</p>' : ""}`,
  );
  async function change(path: string, method: string, body?: unknown) {
    const result = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.ok) {
      const data = (await result.json().catch((caughtError6) => {
        journalCaught(caughtError6, "workspace.change.json", null);
        return null;
      })) as { error?: string } | null;
      throw new Error(data?.error ?? "The change could not be saved. Try again.");
    }
  }
  async function report(action: () => Promise<void>) {
    const feedback = root!.querySelector("#workspace-feedback");
    try {
      await action();
    } catch (error) {
      journalCaught(error, "workspace.report.action", null);
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
    async function loadMembers() {
      const refresh = root!.querySelector<HTMLButtonElement>("[data-members-refresh]")!;
      refresh.disabled = true;
      try {
        const memberResponse = await fetch("/api/workspaces/members", { cache: "no-store" });
        if (!memberResponse.ok)
          throw new Error("Members could not be loaded. Refresh members to try again.");
        const data = (await memberResponse.json()) as {
          members: { id: string; name: string; role: string; active: number }[];
        };
        const list = root!.querySelector("#workspace-members-list");
        if (list !== null) {
          renderMarkup(
            list,
            data.members
              .map(
                (member) =>
                  `<form class="row workspace-member" data-member="${escapeHtml(member.id)}"><span>${escapeHtml(member.name)}${member.active ? "" : " (removed)"}</span><label><span class="sr-only">Role for ${escapeHtml(member.name)}</span><select name="role"${member.active ? "" : " disabled"}>${["owner", "admin", "member", "observer"].map((role) => `<option${role === member.role ? " selected" : ""}>${role}</option>`).join("")}</select></label><button class="btn" type="submit"${member.active ? "" : " disabled"}>Save role</button></form>`,
              )
              .join(""),
          );
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
      } catch (caughtError7) {
        journalCaught(caughtError7, "workspace.loadMembers.fetch", null);
        renderMarkup(
          root!.querySelector("#workspace-members-list")!,
          '<p role="status">Members could not be loaded. Refresh members to try again.</p>',
        );
      } finally {
        refresh.disabled = false;
      }
    }
    root
      .querySelector("[data-members-refresh]")!
      .addEventListener("click", () => void loadMembers());
    loadWhenShown("workspace", () => void loadMembers());
  }
  if (["owner", "admin", "member"].includes(session.role))
    initializeWorkspaceAttribution(root, session.csrfToken);
  initializeWorkspaceGitHub(root, session.csrfToken, session.role === "owner");
  initializeDecisions(root, session.csrfToken, session.role !== "observer");
  if (["owner", "admin"].includes(session.role)) {
    initializeWorkspaceIdentities(root, session.csrfToken);
    initializeWorkspaceAudit(root);
  }
  showWorkspaceSettingsPage(page());
  return true;
}

export function showWorkspaceSettingsPage(page: SettingsPage | null): void {
  for (const section of document.querySelectorAll<HTMLElement>(
    "#workspace-access [data-settings-page]",
  ))
    section.hidden = section.dataset.settingsPage !== page;
  settingsPageShown(page);
}

export function linearConnectionMarkup(name: string): string {
  return `<section data-settings-page="integrations" class="settings-section"><div><h2>Linear</h2><p class="sub">Work, planning, and questions stay in Linear.</p></div><div class="settings-account"><div class="row"><span class="pill ok">Connected</span><span>${escapeHtml(name)}</span></div></div></section>`;
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

function setLoginLayout(login: boolean): void {
  for (const selector of ["#top", "#banner", "#linear-session-start"]) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) element.hidden = login;
  }
}
