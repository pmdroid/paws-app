import { journalCaught } from "../../../journal";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";
import { esc } from "./format";
type AuditEntry = {
  id: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  subject: string;
  createdAt: number;
};

export function initializeWorkspaceAudit(root: HTMLElement) {
  const history = document.createElement("section");
  history.className = "workspace-audit settings-account";
  history.dataset.settingsPage = "audit";
  renderMarkup(
    history,
    `<h2>Recent changes</h2><p class="empty:hidden" role="status"></p><div data-audit-table></div><div class="row"><button class="btn" type="button" data-audit="refresh">Refresh history</button><button class="btn" type="button" data-audit="older" hidden>Load older changes</button></div>`,
  );
  root.append(history);
  const table = history.querySelector<HTMLElement>("[data-audit-table]")!;
  let entries: AuditEntry[] = [];
  const status = history.querySelector("[role=status]")!;
  const refresh = history.querySelector<HTMLButtonElement>('[data-audit="refresh"]')!;
  const older = history.querySelector<HTMLButtonElement>('[data-audit="older"]')!;
  let nextBefore: number | null = null;
  let pending = false;
  function renderRows() {
    renderMarkup(
      table,
      `<table tabindex="0" aria-label="Workspace audit changes" class="min-w-[48rem] [&_td]:break-words [&_td]:align-top [&_th]:bg-secondary-background [&_th]:whitespace-nowrap [&_td:first-child]:whitespace-nowrap [&_td:nth-child(3)]:whitespace-nowrap"><thead><tr><th scope="col">Time</th><th scope="col">Change</th><th scope="col">Person</th><th scope="col">Details</th></tr></thead><tbody>${entries
        .map((entry) => {
          const date = new Date(entry.createdAt);
          return `<tr><td><time datetime="${date.toISOString()}">${esc(date.toLocaleString())}</time></td><td><strong>${esc(entry.action.replaceAll(".", " "))}</strong></td><td>${esc(entry.actorName ?? entry.actorId ?? "Paws")}</td><td>${esc(entry.subject)}</td></tr>`;
        })
        .join("")}</tbody></table>`,
    );
  }
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
        entries = [];
        renderRows();
        nextBefore = null;
        throw new Error("Workspace administration is required. Sign in again to check access.");
      }
      if (!response.ok) throw new Error("Audit history could not be loaded. Refresh to try again.");
      const page = (await response.json()) as { entries: AuditEntry[]; nextBefore: number | null };
      entries = append ? [...entries, ...page.entries] : page.entries;
      renderRows();
      nextBefore = page.nextBefore;
      status.textContent = entries.length === 0 ? "No workspace changes recorded yet." : "";
    } catch (error) {
      journalCaught(error, "workspace-audit.load.fetch", null);
      status.textContent = error instanceof Error ? error.message : "Audit history is unavailable.";
    } finally {
      pending = false;
      refresh.disabled = false;
      older.disabled = false;
      older.hidden = nextBefore === null;
    }
  }
  loadWhenShown("audit", () => void load(false));
  refresh.addEventListener("click", () => void load(false));
  older.addEventListener("click", () => void load(true));
}
