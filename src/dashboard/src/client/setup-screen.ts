import { settingsPageShown } from "./settings-loads";
import { renderMarkup } from "./theme";
import { initializeWorkspaceGitHub } from "./workspace-github";

export const TWO_ROLE_REQUIREMENT =
  "To set up Paws you need to be an admin of your Linear workspace. Paws's GitHub App must be installed on the GitHub organization or account whose repositories it will work on; installing it needs an owner of that organization. After setup, other people only need to sign in with Linear.";

const GITHUB_REQUIREMENT =
  "Paws's GitHub App must be installed on the organization or account whose repositories it will work on. Installing it needs an owner of that organization; connecting it here needs only read access to those repositories.";

const STEPS = [
  ["done", "Linear connected", "Paws takes work from issues you delegate to it in Linear."],
  ["next", "Connect GitHub", GITHUB_REQUIREMENT],
  ["todo", "Choose repositories", "Match each repository to the Linear teams that can use it."],
] as const;

export function renderSetupScreen(
  content: HTMLElement,
  options: { admin: boolean; csrfToken: string; signOut(): Promise<void> },
): void {
  const signOut =
    '<p data-setup-feedback role="alert" class="empty:hidden"></p><button class="btn self-start" type="button" data-setup-signout>Sign out</button>';
  if (!options.admin) {
    renderMarkup(
      content,
      `<section class="login-panel" data-setup-screen="member"><h1>Paws is being set up</h1><p>An admin is still setting up Paws. You'll be able to use it once GitHub is connected.</p>${signOut}</section>`,
    );
  } else {
    const steps = STEPS.map(
      ([state, title, help], index) =>
        `<li class="flex gap-3 border-t border-border py-3 first:border-t-0" data-setup-step="${state}"${state === "next" ? ' aria-current="step"' : ""}><span class="grid size-6 shrink-0 place-items-center rounded-full border border-current font-mono text-xs" aria-hidden="true">${state === "done" ? "✓" : index + 1}</span><div class="flex min-w-0 flex-col gap-1"><b>${title}</b><span class="muted text-sm">${help}</span></div></li>`,
    ).join("");
    renderMarkup(
      content,
      `<section class="flex min-w-0 flex-col gap-6" data-setup-screen="admin"><div><h1>Set up Paws</h1><p class="muted">Connect GitHub and choose repositories before Paws can take work.</p></div><ol class="flex flex-col" role="list">${steps}</ol><div data-setup-github class="flex min-w-0 flex-col gap-8"></div>${signOut}</section>`,
    );
    initializeWorkspaceGitHub(
      content.querySelector<HTMLElement>("[data-setup-github]")!,
      options.csrfToken,
      true,
    );
    document.addEventListener("paws:github-access-changed", () => location.reload(), {
      once: true,
    });
    settingsPageShown("integrations");
  }
  const feedback = content.querySelector<HTMLElement>("[data-setup-feedback]")!;
  content.querySelector("[data-setup-signout]")!.addEventListener("click", () => {
    feedback.textContent = "";
    void options.signOut().catch((error: unknown) => {
      feedback.textContent = error instanceof Error ? error.message : "Sign-out failed.";
    });
  });
}
