import { renderMarkup } from "./theme";
type AuditEntry = {
  id: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  subject: string;
  createdAt: number;
};

export function initializeWorkspaceAudit(root: HTMLElement) {
  const history = document.createElement("details");
  history.className = "workspace-audit";
  renderMarkup(
    history,
    `<summary>Audit history</summary><p class="muted">Workspace access and administration changes, newest first.</p><p role="status"></p><ol tabindex="0" aria-label="Workspace audit changes"></ol><div class="row"><button class="btn" type="button" data-audit="refresh">Refresh history</button><button class="btn" type="button" data-audit="older" hidden>Load older changes</button></div>`,
  );
  root.append(history);
  const list = history.querySelector("ol")!;
  const status = history.querySelector("[role=status]")!;
  const refresh = history.querySelector<HTMLButtonElement>('[data-audit="refresh"]')!;
  const older = history.querySelector<HTMLButtonElement>('[data-audit="older"]')!;
  let nextBefore: number | null = null;
  let loaded = false;
  let pending = false;
  async function load(append: boolean) {
    if (pending) return;
    pending = true;
    refresh.disabled = true;
    older.disabled = true;
    status.textContent = "Loading audit history…";
    try {
      const response = await fetch(
        `/api/workspaces/audit${append ? `?before=${nextBefore}` : ""}`,
        { cache: "no-store" },
      );
      if (response.status === 401 || response.status === 403) {
        list.replaceChildren();
        nextBefore = null;
        throw new Error("Workspace administration is required. Sign in again to check access.");
      }
      if (!response.ok) throw new Error("Audit history could not be loaded. Refresh to try again.");
      const page = (await response.json()) as { entries: AuditEntry[]; nextBefore: number | null };
      const rows = page.entries.map((entry) => {
        const row = document.createElement("li");
        const when = document.createElement("time");
        const date = new Date(entry.createdAt);
        when.dateTime = date.toISOString();
        when.textContent = date.toLocaleString();
        const action = document.createElement("strong");
        action.textContent = entry.action.replaceAll(".", " ");
        const actor = document.createElement("span");
        actor.textContent = entry.actorName ?? entry.actorId ?? "Paws";
        const subject = document.createElement("span");
        subject.className = "muted";
        subject.textContent = entry.subject;
        row.append(when, action, actor, subject);
        return row;
      });
      if (!append) list.replaceChildren();
      list.append(...rows);
      nextBefore = page.nextBefore;
      loaded = true;
      status.textContent = list.children.length === 0 ? "No workspace changes recorded yet." : "";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Audit history is unavailable.";
    } finally {
      pending = false;
      refresh.disabled = false;
      older.disabled = false;
      older.hidden = nextBefore === null;
    }
  }
  history.addEventListener("toggle", () => {
    if (history.open && !loaded) void load(false);
  });
  refresh.addEventListener("click", () => void load(false));
  older.addEventListener("click", () => void load(true));
}
